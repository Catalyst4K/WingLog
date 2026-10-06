import type { NavdataTaxiSegment } from '@shared/ipc'
import { flatDistanceM, toLocalXy } from '@shared/geo'

/**
 * Traces a BeyondATC taxi clearance through the airport's real taxi network, instead of
 * highlighting every segment that shares a taxiway name (winglog-backend's
 * docs/plans/beyondatc-taxi-route-highlight.md). Real bug that prompted this, VHHH
 * 2026-09-30: "taxi to holding point B10, runway 25C, via B8, B" lit up all ~3.9 km of B
 * across the airport; the real route is ~0.9 km.
 *
 * A shortest path (Dijkstra) over (node, stage) states, where the stage is how far through
 * the cleared taxiway sequence the route has got. Real-data findings it's built around
 * (spiked live against VHHH's facility data, same date):
 * - Segments join at shared TAXI_POINTs, so identical endpoint coordinates are the graph's
 *   nodes.
 * - The sim's own taxiway names don't always match ATC's: VHHH's scenery calls the 137 m
 *   stretch between B and B10 "B12", which the clearance never mentions. Segments with an
 *   unlisted name are allowed, at `OFF_ROUTE_COST_FACTOR` times their length, so the cleared
 *   names always win but a short scenery-naming gap doesn't break the whole trace.
 * - Unnamed segments (junction fillets, stand lead-ins) cost their plain length. So does any
 *   segment before the route reaches its first cleared taxiway: getting from the stand to the
 *   cleared route is the pilot's choice (VHHH, flight 230: B8 at 5× lost to the lead-ins).
 *
 * Where it ends:
 * - **A holding point** ("taxi to holding point A9 … via C9, B9"): along the holding-point
 *   taxiway to its hold-short point, or to its far end if that comes first — where it meets
 *   the runway, which isn't in the taxi network, so a dead end (nothing else joins there; a
 *   point where the name merely stops, like ZJSY's A becoming A1, isn't one). YBBN's A9 (real flight,
 *   2026-10-02) carries its only hold-short flag at the B9 end, where the aircraft *enters*
 *   A9; requiring a hold-short point made every YBBN trace fail, falling back to whole
 *   taxiways (the "star at every junction" report).
 * - **A stand** ("taxi to Stand N32 via J, H6, H, V, B"): with the stand's position (the sim's
 *   TAXI_PARKING data, stand-positions.md), on along the network to the point nearest the
 *   stand and then the stand itself. Without it — or if the stand can't be reached that way —
 *   where the route joins its last cleared taxiway: the part that's certain, rather than every
 *   segment of J, H6, H, V and B across the airport.
 * The holding point must be a taxiway name in the data; otherwise null, and the caller falls
 * back to highlighting whole taxiways by name.
 */

const OFF_ROUTE_COST_FACTOR = 5
/** How far a stand's own point may be from the taxi network's nearest point (its lead-in line
 *  normally ends right at it). */
const MAX_STAND_LINK_M = 150
/** How far the aircraft may be from the nearest taxi-network point to start a trace. */
const MAX_START_DISTANCE_M = 300
/** A cleared taxi route longer than this is almost certainly a wrong trace, not a real one. */
const MAX_ROUTE_LENGTH_M = 15_000


export interface TaxiTraceRequest {
  segments: NavdataTaxiSegment[]
  /** The cleared taxiways, in order, as ATC said them ("via B8, B" → ['B8', 'B']). */
  taxiways: string[]
  /** "holding point B10" → 'B10'; null for a stand clearance. */
  holdingPoint: string | null
  from: { lat: number; lon: number }
  /** A stand clearance's stand, positioned (the `Taxi to Gate` box + the sim's
   *  stands); ignored for a holding-point clearance. */
  stand?: { lat: number; lon: number } | null
  /** The aircraft's true heading, when it's taxiing under its own power. A first edge pointing
   *  more than WRONG_WAY_DEG away from it costs an extra WRONG_WAY_PENALTY_M, so the
   *  route starts forwards; a U-turn is still taken when it's the only way (dead-end stand
   *  rows). Null or absent: no preference. */
  headingDeg?: number | null
}

interface Edge {
  to: number
  name: string | null
  lengthM: number
}

/** [lon, lat] pairs, GeoJSON order, from the aircraft's nearest network point to the hold. */
export type TracedRoute = [number, number][]

/** Above this from the aircraft's heading, a first edge counts as going the wrong way. */
export const WRONG_WAY_DEG = 120
/** An airliner can't turn round in the middle of a taxiway, so starting the wrong way costs more
 *  than any sensible way round; it only wins when there's no way forwards at all (a dead-end
 *  stand row). A ×10 factor on the first edge wasn't enough: with a short first edge, YBBN
 *  (flight 225, simulated) re-routed back behind the aircraft twice before following it. */
const WRONG_WAY_PENALTY_M = 3_000

/** Smallest angle between two bearings, 0-180. */
export function angleBetweenDeg(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360)
  return d > 180 ? 360 - d : d
}

interface Graph {
  nodeIndex: Map<string, number>
  nodes: { lat: number; lon: number; holdShort: boolean }[]
  edges: Edge[][]
  distanceM: (aLat: number, aLon: number, bLat: number, bLon: number) => number
  bearingDeg: (a: number, b: number) => number
}

const nodeKey = (lat: number, lon: number): string => `${lat.toFixed(7)},${lon.toFixed(7)}`

/** Segments join at shared TAXI_POINTs, so identical endpoint coordinates are the nodes. */
function buildGraph(segments: NavdataTaxiSegment[], refLat: number): Graph {
  const cosLat = Math.cos((refLat * Math.PI) / 180)
  const distanceM = (aLat: number, aLon: number, bLat: number, bLon: number): number =>
    flatDistanceM({ lat: aLat, lon: aLon }, { lat: bLat, lon: bLon }, refLat)
  const nodeIndex = new Map<string, number>()
  const nodes: Graph['nodes'] = []
  const edges: Edge[][] = []
  const nodeFor = (lat: number, lon: number, holdShort: boolean): number => {
    const key = nodeKey(lat, lon)
    let index = nodeIndex.get(key)
    if (index === undefined) {
      index = nodes.length
      nodeIndex.set(key, index)
      nodes.push({ lat, lon, holdShort })
      edges.push([])
    } else if (holdShort) {
      nodes[index]!.holdShort = true
    }
    return index
  }
  for (const s of segments) {
    const a = nodeFor(s.startLat, s.startLon, s.startHoldShort)
    const b = nodeFor(s.endLat, s.endLon, s.endHoldShort)
    const lengthM = distanceM(s.startLat, s.startLon, s.endLat, s.endLon)
    edges[a]!.push({ to: b, name: s.name, lengthM })
    edges[b]!.push({ to: a, name: s.name, lengthM })
  }
  const bearingDeg = (a: number, b: number): number => {
    const dx = (nodes[b]!.lon - nodes[a]!.lon) * cosLat
    const dy = nodes[b]!.lat - nodes[a]!.lat
    return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360
  }
  return { nodeIndex, nodes, edges, distanceM, bearingDeg }
}

/** The network point nearest `from`, or -1 beyond MAX_START_DISTANCE_M. */
function nearestNode({ nodes, distanceM }: Graph, from: { lat: number; lon: number }): number {
  let start = -1
  let startDistance = Infinity
  for (const [i, node] of nodes.entries()) {
    const d = distanceM(from.lat, from.lon, node.lat, node.lon)
    if (d < startDistance) {
      startDistance = d
      start = i
    }
  }
  return startDistance > MAX_START_DISTANCE_M ? -1 : start
}

export function traceTaxiRoute(request: TaxiTraceRequest): TracedRoute | null {
  if (request.holdingPoint) return traceOnce(request, true) ?? traceOnce(request, false)
  if (!request.stand) return traceOnce(request, true)
  return traceOnce(request, true) ?? traceOnce({ ...request, stand: null }, true)
}

/** `strictEnd`: a holding-point route must end at a hold short or a true dead end. Without one
 *  reachable (scenery with no hold-short flags whose taxiway runs into another), the second try
 *  accepts where the holding-point taxiway's name stops. */
function traceOnce(
  { segments, taxiways, holdingPoint, from, stand, headingDeg = null }: TaxiTraceRequest,
  strictEnd: boolean
): TracedRoute | null {
  if (taxiways.length === 0) return null
  if (holdingPoint && !segments.some((s) => s.name === holdingPoint)) return null

  const graph = buildGraph(segments, from.lat)
  const { nodes, edges, distanceM, bearingDeg } = graph
  const start = nearestNode(graph, from)
  if (start < 0) return null

  let standNode = -1
  if (!holdingPoint && stand) {
    let best = MAX_STAND_LINK_M
    for (const [i, node] of nodes.entries()) {
      const d = distanceM(stand.lat, stand.lon, node.lat, node.lon)
      if (d <= best) {
        best = d
        standNode = i
      }
    }
    if (standNode < 0) return null
  }

  // The holding point is the route's last leg — "holding point B10 ... via B8, B" is driven
  // as B8 → B → B10.
  const sequence = !holdingPoint || taxiways.at(-1) === holdingPoint ? taxiways : [...taxiways, holdingPoint]
  const last = sequence.length - 1
  // State = node * (stages + 1) + (stage + 1); stage -1 is the lead-in before the first
  // cleared taxiway.
  const stateOf = (node: number, stage: number): number => node * (sequence.length + 1) + stage + 1
  const startState = stateOf(start, -1)
  const cost = new Map<number, number>([[startState, 0]])
  const realLength = new Map<number, number>([[startState, 0]])
  const previous = new Map<number, number>()
  const queue = new MinQueue()
  queue.push(startState, 0)

  const cameFromNodeOf = (state: number): number => {
    const cameFrom = previous.get(state)
    return cameFrom === undefined ? -1 : Math.floor(cameFrom / (sequence.length + 1))
  }
  const isRouteEnd = (state: number, node: number): boolean => {
    if (!holdingPoint) return standNode < 0 || node === standNode
    const cameFromNode = cameFromNodeOf(state)
    // The final stage stays the same over unnamed and off-route edges, so check that the edge
    // just driven really was the holding point's. Without this, ZJSY's "holding point A, runway
    // 08, via D, B7, A" (real flight, 2026-10-02) ended one unnamed fillet off A, ~150 m past
    // B7, instead of at A's hold short by the runway 08 threshold: that fillet's far point has
    // no A edge, so it passed for "A's far end".
    if (cameFromNode < 0 || !edges[cameFromNode]!.some((e) => e.to === node && e.name === holdingPoint)) return false
    if (nodes[node]!.holdShort) return true
    // A real far end: nothing else joins here (the runway isn't in the taxi network). Not merely
    // where the name stops: ZJSY's A forks by the runway 08 threshold, and the branch that isn't
    // the hold carries on as A1.
    if (edges[node]!.every((e) => e.to === cameFromNode)) return true
    return !strictEnd && !edges[node]!.some((e) => e.name === holdingPoint && e.to !== cameFromNode)
  }

  while (queue.size > 0) {
    const [state, stateCost] = queue.pop()
    if (stateCost > (cost.get(state) ?? Infinity)) continue
    const node = Math.floor(state / (sequence.length + 1))
    const stage = (state % (sequence.length + 1)) - 1

    if (stage === last && isRouteEnd(state, node)) {
      if ((realLength.get(state) ?? 0) > MAX_ROUTE_LENGTH_M) return null
      const route: TracedRoute = []
      for (let s: number | undefined = state; s !== undefined; s = previous.get(s)) {
        const n = nodes[Math.floor(s / (sequence.length + 1))]!
        route.push([n.lon, n.lat])
      }
      route.reverse()
      if (stand && standNode >= 0) route.push([stand.lon, stand.lat])
      return route
    }

    // No immediate U-turns: without this, a clearance whose next taxiway is only touched at a
    // junction gets "satisfied" by driving out along it and straight back.
    const cameFromNode = cameFromNodeOf(state)
    for (const edge of edges[node]!) {
      if (edge.to === cameFromNode) continue
      const moves: [number, number][] = []
      const nextName = sequence[stage + 1]
      if (edge.name !== null && edge.name === nextName) moves.push([stage + 1, edge.lengthM])
      if (edge.name === null || (stage >= 0 && edge.name === sequence[stage])) moves.push([stage, edge.lengthM])
      // Before the first cleared taxiway, how to get there is the pilot's choice, so a named
      // taxilane costs its plain length like an unnamed lead-in. VHHH, 2026-10-05: from B8,
      // cleared "via B, B, V, H, J", 5× on B8 sent the line zigzagging through every gate
      // lead-in beside it instead of straight along B8.
      // The same at the other end of a stand clearance: from the last cleared taxiway to the
      // stand. VHHH flight 225, "taxi to N32 via J, H6, H, V, B": the gate taxilane to N32 is
      // B7, which ATC doesn't name, so at 5× the line hopped in and out of every gate lead-in
      // along it (found simulating real taxis, 2026-10-06).
      else if (edge.name !== nextName) {
        const pilotsChoice = stage < 0 || (standNode >= 0 && stage === last)
        moves.push([stage, pilotsChoice ? edge.lengthM : edge.lengthM * OFF_ROUTE_COST_FACTOR])
      }

      const wrongWay = state === startState && headingDeg !== null && angleBetweenDeg(bearingDeg(node, edge.to), headingDeg) > WRONG_WAY_DEG
      for (const [nextStage, edgeCost] of moves) {
        const next = stateOf(edge.to, nextStage)
        const nextCost = stateCost + edgeCost + (wrongWay ? WRONG_WAY_PENALTY_M : 0)
        if (nextCost >= (cost.get(next) ?? Infinity)) continue
        cost.set(next, nextCost)
        realLength.set(next, (realLength.get(state) ?? 0) + edge.lengthM)
        previous.set(next, state)
        queue.push(next, nextCost)
      }
    }
  }
  return null
}

export interface RejoinRequest {
  segments: NavdataTaxiSegment[]
  /** The cleared route as first traced: what a re-route joins back onto. */
  route: TracedRoute
  /** The furthest segment of `route` the aircraft has driven; it only rejoins from there on. */
  fromSegment: number
  from: { lat: number; lon: number }
  /** As TaxiTraceRequest's: the route prefers to start forwards. */
  headingDeg?: number | null
}

/**
 * A re-route (winglog-backend's docs/plans/taxi-reroute.md): the shortest total way from
 * the aircraft to the end of the cleared route, joining it at whichever of its points makes
 * that shortest and then following it. Callum, 2026-10-06: "rejoin the route at the most
 * sensible point to get to the final destination". Getting to the route costs plain distance
 * on any taxiway. Pulling the pilot back to the next cleared taxiway instead pointed flight
 * 227 back along D for the whole taxi while it went the other way to the same hold.
 *
 * Joins only from `fromSegment` on, so never back onto a part already driven. The end (the
 * hold or the stand) is always the original route's. Null when the aircraft is off the
 * network or nothing joins.
 */
export function rejoinTaxiRoute({ segments, route, fromSegment, from, headingDeg = null }: RejoinRequest): TracedRoute | null {
  if (route.length < 2) return null
  const graph = buildGraph(segments, from.lat)
  const { nodes, edges, nodeIndex, distanceM, bearingDeg } = graph
  const start = nearestNode(graph, from)
  if (start < 0) return null

  // Distance left along the route from each of its points to the end.
  const remainingFrom: number[] = new Array<number>(route.length).fill(0)
  for (let i = route.length - 2; i >= 0; i--) {
    const [aLon, aLat] = route[i]!
    const [bLon, bLat] = route[i + 1]!
    remainingFrom[i] = remainingFrom[i + 1]! + distanceM(aLat, aLon, bLat, bLon)
  }

  // Plain-distance Dijkstra over the whole network from the aircraft (a few ms even at VHHH).
  const cost = new Array<number>(nodes.length).fill(Infinity)
  const previous = new Array<number>(nodes.length).fill(-1)
  cost[start] = 0
  const queue = new MinQueue()
  queue.push(start, 0)
  while (queue.size > 0) {
    const [node, nodeCost] = queue.pop()
    if (nodeCost > cost[node]!) continue
    for (const edge of edges[node]!) {
      const wrongWay = node === start && headingDeg !== null && angleBetweenDeg(bearingDeg(node, edge.to), headingDeg) > WRONG_WAY_DEG
      const nextCost = nodeCost + edge.lengthM + (wrongWay ? WRONG_WAY_PENALTY_M : 0)
      if (nextCost >= cost[edge.to]!) continue
      cost[edge.to] = nextCost
      previous[edge.to] = node
      queue.push(edge.to, nextCost)
    }
  }

  let best = { index: -1, total: Infinity }
  for (let i = Math.max(0, fromSegment); i < route.length; i++) {
    const [lon, lat] = route[i]!
    const node = nodeIndex.get(nodeKey(lat, lon))
    if (node === undefined) continue // a stand's own point, not on the network
    const total = cost[node]! + remainingFrom[i]!
    if (total < best.total) best = { index: i, total }
  }
  if (best.index < 0 || best.total > MAX_ROUTE_LENGTH_M + WRONG_WAY_PENALTY_M) return null

  const [joinLon, joinLat] = route[best.index]!
  const path: TracedRoute = []
  for (let n = nodeIndex.get(nodeKey(joinLat, joinLon))!; n !== -1; n = previous[n]!) path.push([nodes[n]!.lon, nodes[n]!.lat])
  path.reverse()
  return [...path, ...route.slice(best.index + 1)]
}

export interface RemainingRoute {
  line: TracedRoute
  /** The segment of `route` nearest the aircraft (`route[segment]` → `route[segment + 1]`). */
  segment: number
  /** How far the aircraft is from that segment, in metres. */
  distanceM: number
  /** That segment's direction of travel, degrees true; null for a zero-length one. */
  bearingDeg: number | null
}

/** Beyond this from the traced line, the aircraft isn't following it — the line is left as is. */
const MAX_FOLLOW_DISTANCE_M = 150

/**
 * What's left of a traced route from the aircraft, drawn from the aircraft itself (Callum,
 * 2026-10-02: the line should start at the plane, not somewhere ahead of it). The part already
 * taxied drops away. `fromSegment` is the furthest segment reached so far — the search never
 * goes back, so a route passing close to itself can't jump backwards.
 */
export function remainingRoute(
  route: TracedRoute,
  position: { lat: number; lon: number },
  fromSegment = 0
): RemainingRoute {
  if (route.length < 2) return { line: route, segment: 0, distanceM: 0, bearingDeg: null }
  const toXy = ([lon, lat]: [number, number]): [number, number] => {
    const { x, y } = toLocalXy({ lat, lon }, position.lat)
    return [x, y]
  }
  const [px, py] = toXy([position.lon, position.lat])

  let best = { segment: fromSegment, distance: Infinity, point: route[fromSegment]! }
  for (let i = fromSegment; i < route.length - 1; i++) {
    const [ax, ay] = toXy(route[i]!)
    const [bx, by] = toXy(route[i + 1]!)
    const lengthSq = (bx - ax) ** 2 + (by - ay) ** 2
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / lengthSq))
    const distance = Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)))
    if (distance < best.distance) {
      const [aLon, aLat] = route[i]!
      const [bLon, bLat] = route[i + 1]!
      best = { segment: i, distance, point: [aLon + t * (bLon - aLon), aLat + t * (bLat - aLat)] }
    }
  }
  let bearingDeg: number | null = null
  if (best.segment + 1 < route.length) {
    const [aX, aY] = toXy(route[best.segment]!)
    const [bX, bY] = toXy(route[best.segment + 1]!)
    if (aX !== bX || aY !== bY) bearingDeg = ((Math.atan2(bX - aX, bY - aY) * 180) / Math.PI + 360) % 360
  }
  if (best.distance > MAX_FOLLOW_DISTANCE_M) {
    return { line: route.slice(fromSegment), segment: fromSegment, distanceM: best.distance, bearingDeg }
  }
  const rest = route.slice(best.segment + 1)
  // Already on the line: no zero-length join from the aircraft to itself.
  const line: TracedRoute = best.distance < 0.5 ? [best.point, ...rest] : [[position.lon, position.lat], best.point, ...rest]
  return { line, segment: best.segment, distanceM: best.distance, bearingDeg }
}

/** A small binary min-heap of (state, cost) — VHHH's real network is ~4,400 points, well
 *  past what a linear-scan "queue" handles comfortably per clearance. */
class MinQueue {
  private readonly items: [number, number][] = []

  get size(): number {
    return this.items.length
  }

  push(state: number, cost: number): void {
    const items = this.items
    items.push([state, cost])
    let i = items.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (items[parent]![1] <= items[i]![1]) break
      ;[items[parent], items[i]] = [items[i]!, items[parent]!]
      i = parent
    }
  }

  pop(): [number, number] {
    const items = this.items
    const top = items[0]!
    const end = items.pop()!
    if (items.length > 0) {
      items[0] = end
      let i = 0
      for (;;) {
        const left = i * 2 + 1
        const right = left + 1
        let smallest = i
        if (left < items.length && items[left]![1] < items[smallest]![1]) smallest = left
        if (right < items.length && items[right]![1] < items[smallest]![1]) smallest = right
        if (smallest === i) break
        ;[items[smallest], items[i]] = [items[i]!, items[smallest]!]
        i = smallest
      }
    }
    return top
  }
}
