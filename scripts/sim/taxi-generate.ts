/**
 * Generated taxi clearances (winglog-backend docs/plans/taxi-and-second-screen-robustness.md, stage 6b). The recorded taxis are 25; the next
 * airport or clearance shape is found by flying it. This makes the cases instead: routes sampled on a real network, then worded the way
 * ATC words them, then handed to the app's trace to see whether it draws the route they came from.
 *
 * It is written apart from the app's tracer on purpose, so the code is not checked against itself: its own graph, its own shortest-path
 * search (with an airliner's turn limit), its own idea of a holding point and a runway crossing. It shares only what defines a good route
 * (`routeProblems`, to throw away samples no aircraft could taxi) and the clearance type it produces.
 *
 * Deterministic: the same airport, kind and seed give the same cases.
 */
import type { NavdataRunway, NavdataStand, NavdataTaxiSegment } from '../../src/shared/ipc'
import { destinationPoint, greatCircleM, initialBearingDeg, toLocalXy } from '../../src/shared/geo'
import { MinQueue } from '../../src/shared/taxi/min-queue'
import { passesAPlaceTwice, sharpestTurn, type Xy } from '../../src/shared/taxi/route-checks'
import type { TaxiClearance } from '../../src/shared/taxi/clearance'
import { angleBetweenDeg } from '../../src/shared/taxi/route-graph'

/** What the generator needs of an airport: the network the app has, and its runways and stands. */
export interface GeneratorAirport {
  icao: string
  segments: NavdataTaxiSegment[]
  runways: NavdataRunway[]
  stands: NavdataStand[]
}

/** How a clearance ends. */
export type EndType = 'holding-point' | 'hold-short' | 'stand'

/** One generated clearance, and the route it was made from. */
export interface GeneratedCase {
  id: string
  icao: string
  endType: EndType
  /** Whether the aircraft is mid-pushback (nose pointing away from the route) when the clearance comes. */
  pushback: boolean
  /** Interior taxiway runs shorter than this were left out of the wording (rule 2's evidence is 34-240 m). */
  linkLimitM: number
  clearance: TaxiClearance
  /** The route the clearance was made from, [lon, lat], from the aircraft to where the clearance ends. */
  truth: [number, number][]
  /** The clearance as ATC would say it. */
  text: string
}

/** The longest and shortest routes worth a clearance, metres. */
const MIN_ROUTE_M = 150
const MAX_ROUTE_M = 9_000
/** The sharpest turn at one junction the search will take. An airliner's route is also checked as a whole (routeProblems). */
const MAX_JUNCTION_TURN_DEG = 100
/** A holding point is a hold short this close to a runway's threshold: as the app's (runway-hold.ts), but its own on purpose, since the
 *  generator is independent of the code it tests. */
const HOLD_NEAR_THRESHOLD_M = 250
/** A stand's lead-in joins the network within this of the stand. */
const STAND_LINK_M = 100
/** A runway exit is a network point this close to the runway's centreline. */
const EXIT_NEAR_RUNWAY_M = 60
/** How long a run of taxiway can be and still be left out of the wording (0 leaves nothing out). */
const LINK_LIMITS_M = [0, 120, 240]
/** Attempts per wanted case before giving up on a network that cannot make them. */
const ATTEMPTS_PER_CASE = 60

// ---- the generator's own graph and search --------------------------------------------------------------------------------------

/** A network point. */
interface GNode {
  lat: number
  lon: number
  holdShort: boolean
}

/** One direction of one segment. */
interface GEdge {
  from: number
  to: number
  name: string | null
  lengthM: number
  /** The bearing from `from` to `to`, degrees true. */
  bearing: number
}

/** The network as the generator searches it. */
export interface GGraph {
  nodes: GNode[]
  edges: GEdge[]
  /** The edge ids leaving each node. */
  out: number[][]
  /** Each node by where it is (see `nodeAtPoint`). */
  index: Map<string, number>
}

const key = (lat: number, lon: number): string => `${lat.toFixed(7)},${lon.toFixed(7)}`

/**
 * @param segments The network.
 * @returns The graph: a node at each distinct end, two directed edges for each segment, a node a hold short if any segment says so there.
 */
export function buildGraph(segments: NavdataTaxiSegment[]): GGraph {
  const nodes: GNode[] = []
  const index = new Map<string, number>()
  const edges: GEdge[] = []
  const out: number[][] = []
  const nodeAt = (lat: number, lon: number, holdShort: boolean): number => {
    const k = key(lat, lon)
    let i = index.get(k)
    if (i === undefined) {
      i = nodes.length
      index.set(k, i)
      nodes.push({ lat, lon, holdShort })
      out.push([])
    } else if (holdShort) {
      nodes[i].holdShort = true
    }
    return i
  }
  for (const s of segments) {
    const a = nodeAt(s.startLat, s.startLon, s.startHoldShort)
    const b = nodeAt(s.endLat, s.endLon, s.endHoldShort)
    if (a === b) continue
    const lengthM = greatCircleM({ lat: s.startLat, lon: s.startLon }, { lat: s.endLat, lon: s.endLon })
    const forward = initialBearingDeg({ lat: s.startLat, lon: s.startLon }, { lat: s.endLat, lon: s.endLon })
    for (const [from, to, bearing] of [
      [a, b, forward],
      [b, a, (forward + 180) % 360]
    ] as const) {
      out[from].push(edges.length)
      edges.push({ from, to, name: s.name, lengthM, bearing })
    }
  }
  return { nodes, edges, out, index }
}

/**
 * @param graph The graph.
 * @param point A route point, [lon, lat], which is a node of the graph.
 * @returns The node there, or -1.
 */
export function nodeAtPoint(graph: GGraph, point: [number, number]): number {
  return graph.index.get(key(point[1], point[0])) ?? -1
}

/**
 * The shortest way from one node to another that an airliner could drive: no turn at a junction sharper than MAX_JUNCTION_TURN_DEG, no
 * turning back on itself, and, when the aircraft's heading is given, a first edge within 90° of it. Dijkstra over directed edges, so the
 * turn limit is part of the search rather than checked afterwards.
 *
 * @param graph The graph.
 * @param from The start node.
 * @param to The end node.
 * @param headingDeg Which way the aircraft's nose points, or null for no preference.
 * @param avoid Edges (and their other directions) the way may not use.
 * @returns The edge ids in order, or null when there is no such way.
 */
export function shortestRoute(
  graph: GGraph,
  from: number,
  to: number,
  headingDeg: number | null = null,
  avoid: ReadonlySet<number> = new Set()
): number[] | null {
  const { edges, out } = graph
  const cost = new Map<number, number>()
  const previous = new Map<number, number>()
  const queue = new MinQueue()
  for (const id of out[from]) {
    if (avoid.has(id) || avoid.has(id ^ 1)) continue
    if (headingDeg !== null && angleBetweenDeg(edges[id].bearing, headingDeg) > 90) continue
    cost.set(id, edges[id].lengthM)
    queue.push(id, edges[id].lengthM)
  }
  while (queue.size > 0) {
    const [id, spent] = queue.pop()
    if (spent > (cost.get(id) ?? Infinity)) continue
    const edge = edges[id]
    if (edge.to === to) {
      const path = [id]
      for (let p = previous.get(id); p !== undefined; p = previous.get(p)) path.push(p)
      return path.reverse()
    }
    for (const nextId of out[edge.to]) {
      const next = edges[nextId]
      if (avoid.has(nextId) || avoid.has(nextId ^ 1)) continue
      if (next.to === edge.from) continue
      if (angleBetweenDeg(edge.bearing, next.bearing) > MAX_JUNCTION_TURN_DEG) continue
      const total = spent + next.lengthM
      if (total < (cost.get(nextId) ?? Infinity)) {
        cost.set(nextId, total)
        previous.set(nextId, id)
        queue.push(nextId, total)
      }
    }
  }
  return null
}

// ---- wording a route as a clearance --------------------------------------------------------------------------------------------

/** A stretch of one named taxiway. */
export interface Run {
  name: string
  lengthM: number
}

/**
 * @param graph The graph.
 * @param path The edge ids of a route.
 * @returns The named taxiways it drives, one run each: unnamed edges (fillets, lead-ins) never break a run, and the ones before the first
 *   named taxiway belong to none.
 */
export function runsOf(graph: GGraph, path: number[]): Run[] {
  const runs: Run[] = []
  for (const id of path) {
    const { name, lengthM } = graph.edges[id]
    if (name === null) {
      if (runs.length > 0) runs[runs.length - 1].lengthM += lengthM
    } else if (runs.at(-1)?.name === name) {
      runs[runs.length - 1].lengthM += lengthM
    } else {
      runs.push({ name, lengthM })
    }
  }
  return runs
}

/**
 * The names ATC would say: a run shorter than the limit between two others is left out (a link between taxiways that ATC does not name),
 * and what that leaves of the same name twice in a row is one.
 *
 * @param runs The route's runs.
 * @param linkLimitM The shortest interior run that is named; 0 leaves nothing out.
 * @returns The names, in order.
 */
export function clearanceNames(runs: Run[], linkLimitM: number): string[] {
  const kept = runs.filter((run, i) => i === 0 || i === runs.length - 1 || run.lengthM >= linkLimitM)
  const names: string[] = []
  for (const run of kept) if (names.at(-1) !== run.name) names.push(run.name)
  return names
}

// ---- sampling -------------------------------------------------------------------------------------------------------------------

/** A small deterministic random number generator. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** @returns A number from a string, so each airport and kind gets its own stream. */
function hashOf(text: string): number {
  let h = 2166136261
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return h >>> 0
}

const pick = <T>(items: T[], random: () => number): T => items[Math.floor(random() * items.length)]

/** @returns The nearest node to a position within `limitM`, or null. */
function nearestNode(graph: GGraph, at: { lat: number; lon: number }, limitM: number): number | null {
  let best: number | null = null
  let bestM = limitM
  graph.nodes.forEach((n, i) => {
    if (Math.abs(n.lat - at.lat) > 0.002 || Math.abs(n.lon - at.lon) > 0.003) return
    const d = greatCircleM(n, at)
    if (d <= bestM) {
      best = i
      bestM = d
    }
  })
  return best
}

/** A runway's centreline as two points. */
interface Centreline {
  ident: string
  a: { lat: number; lon: number }
  b: { lat: number; lon: number }
}

function centrelineOf(r: NavdataRunway): Centreline {
  const a = { lat: r.thresholdLat, lon: r.thresholdLon }
  return { ident: r.ident, a, b: destinationPoint(a, r.headingTrueDeg, r.lengthM) }
}

/** @returns Metres from a point to a runway's centreline segment. */
function distanceToCentreline(p: { lat: number; lon: number }, c: Centreline): number {
  const ref = c.a.lat
  const [pa, pb, pp] = [c.a, c.b, p].map((q) => toLocalXy(q, ref))
  const dx = pb.x - pa.x
  const dy = pb.y - pa.y
  const t = Math.max(0, Math.min(1, ((pp.x - pa.x) * dx + (pp.y - pa.y) * dy) / (dx * dx + dy * dy || 1)))
  return Math.hypot(pa.x + t * dx - pp.x, pa.y + t * dy - pp.y)
}

/** @returns Whether the segment p-q crosses the runway's centreline. */
function crosses(p: { lat: number; lon: number }, q: { lat: number; lon: number }, c: Centreline): boolean {
  const ref = c.a.lat
  const [a, b, r, s] = [c.a, c.b, p, q].map((x) => toLocalXy(x, ref))
  const side = (
    o: { x: number; y: number },
    u: { x: number; y: number },
    v: { x: number; y: number }
  ): number => (u.x - o.x) * (v.y - o.y) - (u.y - o.y) * (v.x - o.x)
  return side(a, b, r) * side(a, b, s) < 0 && side(r, s, a) * side(r, s, b) < 0
}

/** @returns Whether two runway ends are the same strip (08 and 26). */
function sameStrip(a: NavdataRunway, b: NavdataRunway): boolean {
  return (
    a.ident !== b.ident &&
    angleBetweenDeg(a.headingTrueDeg, (b.headingTrueDeg + 180) % 360) < 8 &&
    greatCircleM({ lat: a.thresholdLat, lon: a.thresholdLon }, { lat: b.thresholdLat, lon: b.thresholdLon }) <
      a.lengthM + 300
  )
}

/**
 * @param graph The graph.
 * @param path A route's edge ids.
 * @returns The route as [lon, lat] points.
 */
function pointsOf(graph: GGraph, path: number[]): [number, number][] {
  const first = graph.nodes[graph.edges[path[0]].from]
  return [
    [first.lon, first.lat],
    ...path.map((id): [number, number] => {
      const n = graph.nodes[graph.edges[id].to]
      return [n.lon, n.lat]
    })
  ]
}

/**
 * Whether a route is one an aircraft could taxi, whatever the clearance: not too short or long, no sharp turn, no lap.
 *
 * @param points The route, [lon, lat].
 * @returns True when it is.
 */
function plausible(points: [number, number][]): boolean {
  const ref = points[0][1]
  const xy = points.map(([lon, lat]): Xy => {
    const p = toLocalXy({ lat, lon }, ref)
    return [p.x, p.y]
  })
  let length = 0
  for (let i = 1; i < xy.length; i++) length += Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1])
  return length >= MIN_ROUTE_M && length <= MAX_ROUTE_M && sharpestTurn(xy) <= 135 && !passesAPlaceTwice(xy)
}

/** What a sampler needs about the airport, worked out once. */
interface Prepared {
  airport: GeneratorAirport
  graph: GGraph
  /** Each stand with the node its lead-in joins, for the stands that have one. */
  stands: { stand: NavdataStand; node: number }[]
  /** Each hold short near a runway's threshold: its node and the runway end. */
  holds: { node: number; runway: NavdataRunway }[]
  /** Network points on or beside a runway, where an aircraft vacates it. */
  exits: number[]
  centrelines: { runway: NavdataRunway; line: Centreline }[]
}

function prepare(airport: GeneratorAirport): Prepared {
  const graph = buildGraph(airport.segments)
  const stands = airport.stands.flatMap((stand) => {
    const node = nearestNode(graph, stand, STAND_LINK_M)
    return node === null ? [] : [{ stand, node }]
  })
  const holds = graph.nodes.flatMap((n, node) => {
    if (!n.holdShort) return []
    const near = airport.runways.filter(
      (r) => greatCircleM(n, { lat: r.thresholdLat, lon: r.thresholdLon }) <= HOLD_NEAR_THRESHOLD_M
    )
    if (near.length === 0) return []
    const runway = near.reduce((best, r) =>
      greatCircleM(n, { lat: r.thresholdLat, lon: r.thresholdLon }) <
      greatCircleM(n, { lat: best.thresholdLat, lon: best.thresholdLon })
        ? r
        : best
    )
    return [{ node, runway }]
  })
  const centrelines = airport.runways.map((runway) => ({ runway, line: centrelineOf(runway) }))
  const exits = graph.nodes.flatMap((n, node) =>
    graph.out[node].some((id) => graph.edges[id].name !== null) &&
    centrelines.some(({ line }) => distanceToCentreline(n, line) <= EXIT_NEAR_RUNWAY_M)
      ? [node]
      : []
  )
  return { airport, graph, stands, holds, exits, centrelines }
}

const sayNames = (names: string[]): string => names.join(', ')

/**
 * Builds one case from a route, or null when it does not make a good one.
 *
 * @param prep The airport.
 * @param spec What the case is.
 * @returns The case.
 */
function makeCase(
  prep: Prepared,
  spec: {
    id: string
    endType: EndType
    path: number[]
    linkLimitM: number
    pushback: boolean
    end: { holdingPoint?: string; taxiToRunway?: string; holdShortRunway?: string; stand?: string }
  }
): GeneratedCase | null {
  const { graph } = prep
  if (spec.path.length === 0) return null
  const points = pointsOf(graph, spec.path)
  if (!plausible(points)) return null
  const runs = runsOf(graph, spec.path)
  if (runs.length === 0) return null
  const names = clearanceNames(runs, spec.linkLimitM)
  const first = graph.edges[spec.path[0]]
  const start = graph.nodes[first.from]
  const heading = spec.pushback ? (first.bearing + 180) % 360 : first.bearing
  const clearance: TaxiClearance = {
    taxiways: names,
    holdingPoint: spec.end.holdingPoint ?? null,
    stand: spec.end.stand ?? null,
    holdShortRunway: spec.end.holdShortRunway ?? null,
    taxiToRunway: spec.end.taxiToRunway ?? null,
    from: { lat: start.lat, lon: start.lon, headingDeg: Math.round(heading * 10) / 10 }
  }
  const text = spec.end.holdingPoint
    ? `taxi to holding point ${spec.end.holdingPoint}, runway ${spec.end.taxiToRunway}, via ${sayNames(names)}`
    : spec.end.holdShortRunway
      ? `taxi via ${sayNames(names)}, hold short of runway ${spec.end.holdShortRunway}`
      : `taxi to stand ${spec.end.stand} via ${sayNames(names)}`
  return {
    id: spec.id,
    icao: prep.airport.icao,
    endType: spec.endType,
    pushback: spec.pushback,
    linkLimitM: spec.linkLimitM,
    clearance,
    truth: points,
    text
  }
}

/**
 * Generated clearances of one kind at one airport.
 *
 * - `holding-point`: a stand to a hold short beside a runway's threshold, "taxi to holding point A, runway 08, via D, B7, A", a quarter of
 *   them with the aircraft mid-pushback, nose pointing away.
 * - `hold-short`: a departure that crosses another runway on the way, stopped at the hold short before it, "taxi via C7, Y, F, hold short
 *   of runway 07C".
 * - `stand`: from where an aircraft leaves a runway to a stand, "taxi to stand N32 via J, H6, H".
 *
 * @param airport The airport's network, runways and stands.
 * @param endType What the clearances end at.
 * @param count How many cases are wanted; fewer come back when the network cannot make them.
 * @param seed Changes which cases are sampled.
 * @returns The cases.
 */
export function sampleCases(
  airport: GeneratorAirport,
  endType: EndType,
  count: number,
  seed = 1
): GeneratedCase[] {
  const prep = prepare(airport)
  const random = mulberry32(hashOf(`${airport.icao}/${endType}/${seed}`))
  const cases: GeneratedCase[] = []
  const seen = new Set<string>()
  const add = (made: GeneratedCase | null): void => {
    if (!made) return
    const signature = `${made.clearance.taxiways.join('>')}|${made.clearance.holdingPoint}|${made.clearance.stand}|${made.clearance.holdShortRunway}|${made.clearance.from?.lat}`
    if (seen.has(signature)) return
    seen.add(signature)
    cases.push(made)
  }
  const wanted = (): boolean => cases.length < count
  for (let attempt = 0; attempt < count * ATTEMPTS_PER_CASE && wanted(); attempt++) {
    const linkLimitM = LINK_LIMITS_M[cases.length % LINK_LIMITS_M.length]
    const id = `${airport.icao}-${endType}-${cases.length + 1}`
    if (endType === 'stand') {
      if (prep.exits.length === 0 || prep.stands.length === 0) break
      const from = pick(prep.exits, random)
      const to = pick(prep.stands, random)
      const path = shortestRoute(prep.graph, from, to.node)
      if (path)
        add(makeCase(prep, { id, endType, path, linkLimitM, pushback: false, end: { stand: to.stand.name } }))
    } else {
      if (prep.stands.length === 0 || prep.holds.length === 0) break
      const from = pick(prep.stands, random)
      const hold = pick(prep.holds, random)
      const pushback = endType === 'holding-point' && random() < 0.25
      const path = shortestRoute(prep.graph, from.node, hold.node)
      if (!path) continue
      const name = prep.graph.edges[path[path.length - 1]].name
      if (endType === 'holding-point') {
        if (name === null) continue
        add(
          makeCase(prep, {
            id,
            endType,
            path,
            linkLimitM,
            pushback,
            end: { holdingPoint: name, taxiToRunway: hold.runway.ident }
          })
        )
      } else {
        add(makeCase(prep, crossingSpec(prep, path, { id, linkLimitM }, hold.runway)))
      }
    }
  }
  return cases
}

/**
 * A departure route cut short at a runway it crosses: stopped at the last hold short before the crossing.
 *
 * @param prep The airport.
 * @param path A route to a holding point.
 * @param base The case's id and link limit.
 * @param own The runway the route is going to, which it does not count as crossing.
 * @returns What to make the case from, or a spec that makes none when the route crosses nothing.
 */
function crossingSpec(
  prep: Prepared,
  path: number[],
  base: { id: string; linkLimitM: number },
  own: NavdataRunway
): Parameters<typeof makeCase>[1] {
  const { graph } = prep
  const none = { ...base, endType: 'hold-short' as const, path: [] as number[], pushback: false, end: {} }
  for (let i = 0; i < path.length; i++) {
    const edge = graph.edges[path[i]]
    const p = graph.nodes[edge.from]
    const q = graph.nodes[edge.to]
    const crossed = prep.centrelines.find(
      ({ runway, line }) => runway.ident !== own.ident && !sameStrip(runway, own) && crosses(p, q, line)
    )
    if (!crossed) continue
    // The last hold short before this edge, on the way to the crossing.
    for (let k = i; k >= 0; k--) {
      if (!graph.nodes[graph.edges[path[k]].to].holdShort) continue
      const head = path.slice(0, k + 1)
      const name = graph.edges[head[head.length - 1]].name
      if (name === null || head.length < 2) return none
      return {
        ...base,
        endType: 'hold-short',
        path: head,
        pushback: false,
        end: { holdShortRunway: crossed.runway.ident }
      }
    }
    return none
  }
  return none
}
