/** Where a taxi re-route joins the cleared line again, and how much of the line is left (taxi-reroute.md). */
import type { NavdataTaxiSegment } from '@shared/ipc'
import { toLocalXy } from '@shared/geo'
import { itemAt } from '@shared/item-at'
import { MinQueue } from './min-queue'
import {
  angleBetweenDeg,
  buildGraph,
  edgesOf,
  isWrongWay,
  nodeKey,
  ON_TAXIWAY_DEG,
  segmentsUnder,
  startNodes,
  WRONG_WAY_PENALTY_M,
  type Graph,
  type GraphNode
} from './route-graph'
import { MAX_ROUTE_LENGTH_M, type RunwayStrip, type TracedRoute } from './route-types'
import { holdsOnSide } from './runway-crossing'
import { turnCost, turnedBefore, TURN_WINDOW_M } from './route-turns'

export interface RejoinRequest {
  segments: NavdataTaxiSegment[]
  /** The cleared route as first traced: what a re-route joins back onto. */
  route: TracedRoute
  /** The furthest segment of `route` the aircraft has driven; it only rejoins from there on. */
  fromSegment: number
  from: { lat: number; lon: number }
  /** As TaxiTraceRequest's: the route prefers to start forwards. */
  headingDeg?: number | null
  /** The runway of a "hold short of runway" clearance: the re-route may end at another hold short of it (holdsOnSide). */
  holdShortRunway?: RunwayStrip | null
}

/**
 * A re-route (winglog-backend's docs/plans/taxi-reroute.md): the shortest total way from the aircraft to the end of the
 * cleared route, joining it at whichever of its points makes that shortest and then following it. Getting to the route
 * costs plain distance on any taxiway; pulling the pilot back to the next cleared taxiway instead pointed back along
 * the route for a whole taxi while the aircraft went the other way to the same hold. The way back keeps the cleared route's
 * driving rules (winglog-backend's docs/plans/taxi-routing-rules.md): it starts ahead of the nose (rule 5) and turns no sharper
 * than an airliner can, from the nose on, on the way and onto the cleared route (rule 4, route-turns.ts).
 *
 * Joins only from `fromSegment` on, so never back onto a part already driven. The end (the hold or the stand) is the original
 * route's, or for a "hold short of runway" route another hold short of that runway on the same side, if nearer (holdsOnSide).
 * Of the ways, the cheapest that passes no point twice: a re-route laps round a block back to a turn the aircraft has just driven
 * past only when there is no other way (EGLL flight 239, on past the turn to its 27L hold short). Null when the aircraft is off the
 * network or nothing joins.
 *
 * @param request The network, the cleared route, how far along it the aircraft is, and where it is.
 * @returns The new route, or null.
 */
export function rejoinTaxiRoute({
  segments,
  route,
  fromSegment,
  from,
  headingDeg = null,
  holdShortRunway = null
}: RejoinRequest): TracedRoute | null {
  const last = route.at(-1)
  if (route.length < 2 || !last) return null
  const graph = buildGraph(segments, from.lat)
  const starts = startNodes(graph, from, headingDeg)
  if (starts.length === 0) return null
  // However far it is, the next point along the taxiway being driven: on a long straight none lies within startNodes' reach, and the
  // only points that do can be on a junction's fillet curving back the way the aircraft came (VHHH flight 253's arrival).
  const onward = headingDeg === null ? null : nodeAheadOnTaxiway(graph, from, headingDeg)
  if (onward && !starts.some((s) => s.node === onward.node)) starts.push(onward)

  // Dijkstra over the whole network from the aircraft, by node and the node come from (a few ms even at VHHH).
  const ways = waysBack(graph, addNose(graph, from, headingDeg, starts), headingDeg)
  const holds = holdShortRunway
    ? holdsOnSide(graph, holdShortRunway, { lat: last[1], lon: last[0] })
    : new Set<number>()
  const candidates = [...joins(graph, route, fromSegment, ways), ...holdEnds(ways, holds)]
    .filter((c) => c.total <= MAX_ROUTE_LENGTH_M + WRONG_WAY_PENALTY_M)
    // Of equal ways (one starting at the point under the aircraft, one at the next), the one keeping more of the cleared route.
    .sort((a, b) =>
      Math.abs(a.total - b.total) > 0.01 ? a.total - b.total : (a.index ?? Infinity) - (b.index ?? Infinity)
    )
  const lineOf = (c: Candidate): TracedRoute =>
    fromAircraft(graph, from, candidateLine(graph, ways, route, fromSegment, c))
  for (const c of candidates) {
    const line = lineOf(c)
    if (!passesAPointTwice(line)) return line
  }
  const cheapest = candidates[0]
  return cheapest ? lineOf(cheapest) : null
}

/** A way to end a re-route: a state the way back reaches, its total cost, and the cleared route's point it joins at, or null for
 *  another hold short of the runway (holdsOnSide). */
interface Candidate {
  index: number | null
  state: number
  total: number
}

/**
 * @param graph The graph.
 * @param ways The ways back.
 * @param route The cleared route.
 * @param fromSegment The furthest segment of it driven.
 * @param candidate The way to end.
 * @returns The re-route's line, without the nose's two points.
 */
function candidateLine(
  graph: Graph,
  ways: WaysBack,
  route: TracedRoute,
  fromSegment: number,
  { index, state }: Candidate
): TracedRoute {
  const nodes = nodesBack(ways, state, Infinity).reverse().slice(2)
  const point = (n: number): [number, number] => {
    const node = itemAt(graph.nodes, n, 'taxi node')
    return [node.lon, node.lat]
  }
  if (index === null) return nodes.map(point)
  // The way back ends where it first meets the cleared route, which is followed from there: the shortest way may run on past
  // cleared taxiways to a join near the end, skipping the stretch ATC cleared (EGLL flight 239's last leg).
  const onRoute = firstOnRoute(graph, nodes, route, fromSegment, index)
  return [...nodes.slice(0, onRoute.at + 1).map(point), ...route.slice(onRoute.index + 1)]
}

/**
 * @param line A line.
 * @returns True if it comes back to a point it has already passed (a point repeated straight after itself doesn't count).
 */
function passesAPointTwice(line: TracedRoute): boolean {
  const seen = new Set<string>()
  let previous = ''
  for (const [lon, lat] of line) {
    const key = nodeKey(lat, lon)
    if (key === previous) continue
    if (seen.has(key)) return true
    seen.add(key)
    previous = key
  }
  return false
}

/**
 * A re-route's line from the aircraft itself: its first point can be the next one along the taxiway, a long straight ahead, and a
 * line starting there would leave the aircraft that far off it and re-route again (ZJSY flight 227's last re-route).
 *
 * @param graph The graph.
 * @param from The aircraft's position.
 * @param line The re-route's line.
 * @returns The line, starting at the aircraft.
 */
function fromAircraft(graph: Graph, from: { lat: number; lon: number }, line: TracedRoute): TracedRoute {
  const first = line[0]
  return first && graph.distanceM(from.lat, from.lon, first[1], first[0]) > 1
    ? [[from.lon, from.lat], ...line]
    : line
}

/**
 * The next network point along the taxiway the aircraft is driving along, however far ahead: of the segments within ON_TAXIWAY_M,
 * the one the nose follows most closely (within ON_TAXIWAY_DEG). Not simply the nearest: just past a junction, the start of a fillet
 * leaving the taxiway at a shallow angle can be nearer than the taxiway itself (VHHH flight 253's arrival).
 *
 * @param graph The graph.
 * @param at The aircraft's position.
 * @param headingDeg Its true heading.
 * @returns The point and its distance, or null when the aircraft isn't driving along a segment that ends ahead.
 */
export function nodeAheadOnTaxiway(
  graph: Graph,
  at: { lat: number; lon: number },
  headingDeg: number
): { node: number; distanceM: number } | null {
  const cosLat = Math.cos((at.lat * Math.PI) / 180)
  const isAhead = (n: number): boolean => {
    const node = itemAt(graph.nodes, n, 'taxi node')
    const bearing = (Math.atan2((node.lon - at.lon) * cosLat, node.lat - at.lat) * 180) / Math.PI
    return angleBetweenDeg(bearing, headingDeg) <= 90
  }
  // Not the stretch just driven, whose far end is behind: on a straight it lines up with the nose as well as the one under it
  // (ZJSY flight 253's departure, 6 m past the point between them).
  const along = segmentsUnder(graph, at, headingDeg)
    .filter((s) => s.offDeg <= ON_TAXIWAY_DEG && isAhead(s.ahead))
    .sort((x, y) => x.offDeg - y.offDeg || x.distanceM - y.distanceM)[0]
  if (!along) return null
  const node = itemAt(graph.nodes, along.ahead, 'taxi node')
  return { node: along.ahead, distanceM: graph.distanceM(at.lat, at.lon, node.lat, node.lon) }
}

/**
 * Where a way back first meets the cleared route.
 *
 * @param graph The graph.
 * @param nodes The way back, from the aircraft's node to its join.
 * @param route The cleared route.
 * @param fromSegment The furthest segment driven; only later points count.
 * @param joinIndex The route index of the way back's last node, used if no earlier node is on the route.
 * @returns The position in `nodes` of the first node on the route, and that node's (first) index in `route`.
 */
function firstOnRoute(
  graph: Graph,
  nodes: number[],
  route: TracedRoute,
  fromSegment: number,
  joinIndex: number
): { at: number; index: number } {
  const indexOf = new Map<number, number>()
  for (let i = Math.max(0, fromSegment); i < route.length; i++) {
    const [lon, lat] = itemAt(route, i, 'route point')
    const node = graph.nodeIndex.get(nodeKey(lat, lon))
    if (node !== undefined && !indexOf.has(node)) indexOf.set(node, i)
  }
  for (const [at, n] of nodes.entries()) {
    const index = indexOf.get(n)
    if (index !== undefined) return { at, index }
  }
  return { at: nodes.length - 1, index: joinIndex }
}

/** The ways back from the aircraft: each state (a node and the node come from) with its cost and the state before it. */
interface WaysBack {
  graph: Graph
  cost: Map<number, number>
  previous: Map<number, number>
}

/** Where the nose points: two points the graph gains for one search, at the aircraft (`nose`) and behind it along its heading
 *  (`tail`), joined from `nose` to every start. The search starts at `nose` come from `tail`, so the turn from the heading onto
 *  the first point counts like any other turn: a start on a junction's fillet curving back the way the aircraft came (VHHH flight
 *  253's arrival), or the nearest point a few metres behind (ZJSY flight 253's departure), costs the U-turn it is. */
interface Nose {
  tail: number
  nose: number
}

/** How far behind the aircraft `tail` is: enough to give the heading a direction (turnAt). */
const NOSE_BACK_M = 5

/**
 * Adds the nose's two points to the graph.
 *
 * @param graph The graph, changed.
 * @param from The aircraft's position.
 * @param headingDeg Its heading; null puts both points on the aircraft, with no direction.
 * @param starts Where the way can start (startNodes), each with its distance from the aircraft: the cost of getting there.
 * @returns The two points.
 */
function addNose(
  graph: Graph,
  from: { lat: number; lon: number },
  headingDeg: number | null,
  starts: { node: number; distanceM: number }[]
): Nose {
  const heading = ((headingDeg ?? 0) * Math.PI) / 180
  const back = (metres: number): GraphNode => {
    const m = headingDeg === null ? 0 : metres
    return {
      lat: from.lat - (m * Math.cos(heading)) / 111_320,
      lon: from.lon - (m * Math.sin(heading)) / (111_320 * Math.cos((from.lat * Math.PI) / 180)),
      holdShort: false
    }
  }
  const tail = graph.nodes.push(back(NOSE_BACK_M)) - 1
  graph.edges.push([])
  const nose = graph.nodes.push(back(0)) - 1
  graph.edges.push(starts.map(({ node, distanceM }) => ({ to: node, name: null, lengthM: distanceM })))
  return { tail, nose }
}

const stateOf = (graph: Graph, node: number, cameFrom: number): number =>
  (cameFrom + 1) * graph.nodes.length + node
const nodeOf = (graph: Graph, state: number): number => state % graph.nodes.length
const cameFromOf = (graph: Graph, state: number): number => Math.floor(state / graph.nodes.length) - 1

/**
 * The cheapest way from the aircraft to every node, by the node come from: plain distance, plus WRONG_WAY_PENALTY_M for a first edge
 * against the heading and the cost of turning more than an airliner can (route-turns.ts), from the nose on. No immediate U-turns.
 *
 * @param graph The graph, with the nose added.
 * @param nose The nose (addNose).
 * @param headingDeg The aircraft's heading, or null.
 * @returns Every reached state's cost and the state before it.
 */
function waysBack(graph: Graph, { tail, nose }: Nose, headingDeg: number | null): WaysBack {
  const ways: WaysBack = { graph, cost: new Map(), previous: new Map() }
  const queue = new MinQueue()
  const first = stateOf(graph, nose, tail)
  ways.cost.set(first, 0)
  ways.previous.set(first, stateOf(graph, tail, -1))
  queue.push(first, 0)
  while (queue.size > 0) {
    const [state, stateCost] = queue.pop()
    if (stateCost > (ways.cost.get(state) ?? Infinity)) continue
    const node = nodeOf(graph, state)
    const cameFrom = cameFromOf(graph, state)
    const turned = turnedBefore(graph, nodesBack(ways, state, TURN_WINDOW_M))
    for (const edge of edgesOf(graph, node)) {
      if (edge.to === cameFrom) continue
      const wrongWay = cameFrom === nose && isWrongWay(graph, node, edge.to, headingDeg)
      const next = stateOf(graph, edge.to, node)
      const nextCost =
        stateCost +
        edge.lengthM +
        (wrongWay ? WRONG_WAY_PENALTY_M : 0) +
        turnCost(graph, turned, [cameFrom, node, edge.to])
      if (nextCost >= (ways.cost.get(next) ?? Infinity)) continue
      ways.cost.set(next, nextCost)
      ways.previous.set(next, state)
      queue.push(next, nextCost)
    }
  }
  return ways
}

/**
 * The nodes of the way to a state, latest first.
 *
 * @param ways The ways back.
 * @param state A reached state.
 * @param limitM How far back to go; Infinity for the whole way.
 * @returns The nodes.
 */
function nodesBack({ graph, previous }: WaysBack, state: number, limitM: number): number[] {
  const nodes = [nodeOf(graph, state)]
  let distance = 0
  for (let s = previous.get(state); s !== undefined && distance < limitM; s = previous.get(s)) {
    const a = itemAt(graph.nodes, itemAt(nodes, nodes.length - 1, 'route node'), 'taxi node')
    const b = itemAt(graph.nodes, nodeOf(graph, s), 'taxi node')
    distance += graph.distanceM(a.lat, a.lon, b.lat, b.lon)
    nodes.push(nodeOf(graph, s))
  }
  return nodes
}

/**
 * Where the cleared route can be joined: each reached state on one of its points, from `fromSegment` on, with the cost to it plus
 * the distance left along the route after it plus the cost of turning onto it.
 *
 * @param graph The graph.
 * @param route The cleared route.
 * @param fromSegment The furthest segment driven.
 * @param ways The ways back from the aircraft.
 * @returns Each join: the point's index in `route`, the state reaching it, and the total.
 */
function joins(graph: Graph, route: TracedRoute, fromSegment: number, ways: WaysBack): Candidate[] {
  // Distance left along the route from each of its points to the end, and the route's points by node.
  const remainingFrom: number[] = new Array<number>(route.length).fill(0)
  for (let i = route.length - 2; i >= 0; i--) {
    const [aLon, aLat] = itemAt(route, i, 'route point')
    const [bLon, bLat] = itemAt(route, i + 1, 'route point')
    remainingFrom[i] = itemAt(remainingFrom, i + 1, 'route point') + graph.distanceM(aLat, aLon, bLat, bLon)
  }
  const nodeAt = (i: number): number | undefined => {
    const point = route[i]
    return point ? graph.nodeIndex.get(nodeKey(point[1], point[0])) : undefined
  }
  const pointsOf = new Map<number, number[]>()
  for (let i = Math.max(0, fromSegment); i < route.length; i++) {
    const node = nodeAt(i)
    // A stand's own point isn't on the network.
    if (node !== undefined) pointsOf.set(node, [...(pointsOf.get(node) ?? []), i])
  }

  const found: Candidate[] = []
  for (const [state, cost] of ways.cost) {
    const node = nodeOf(graph, state)
    for (const i of pointsOf.get(node) ?? []) {
      const onward = nodeAt(i + 1)
      const turning =
        onward === undefined
          ? 0
          : turnCost(graph, turnedBefore(graph, nodesBack(ways, state, TURN_WINDOW_M)), [
              cameFromOf(graph, state),
              node,
              onward
            ])
      found.push({ index: i, state, total: cost + itemAt(remainingFrom, i, 'route point') + turning })
    }
  }
  return found
}

/**
 * @param ways The ways back.
 * @param holds Hold shorts a re-route may end at instead, by node index.
 * @returns Each reached state on one of them, with its cost.
 */
function holdEnds(ways: WaysBack, holds: Set<number>): Candidate[] {
  const found: Candidate[] = []
  for (const [state, cost] of ways.cost)
    if (holds.has(nodeOf(ways.graph, state))) found.push({ index: null, state, total: cost })
  return found
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
export const MAX_FOLLOW_DISTANCE_M = 150

/**
 * What's left of a traced route from the aircraft, drawn from the aircraft itself: the line starts at the plane, and the
 * part already taxied drops away. `fromSegment` is the furthest segment reached so far: the search never goes back, so a
 * route passing close to itself can't jump backwards.
 *
 * @param route The traced route.
 * @param position The aircraft's position.
 * @param fromSegment The furthest segment reached so far.
 * @returns The route left, from the aircraft.
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
  const point = (i: number): [number, number] => itemAt(route, i, 'route point')
  const [px, py] = toXy([position.lon, position.lat])

  let best = { segment: fromSegment, distance: Infinity, point: point(fromSegment) }
  for (let i = fromSegment; i < route.length - 1; i++) {
    const [ax, ay] = toXy(point(i))
    const [bx, by] = toXy(point(i + 1))
    const lengthSq = (bx - ax) ** 2 + (by - ay) ** 2
    const t =
      lengthSq === 0
        ? 0
        : Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / lengthSq))
    const distance = Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)))
    if (distance < best.distance) {
      const [aLon, aLat] = point(i)
      const [bLon, bLat] = point(i + 1)
      best = { segment: i, distance, point: [aLon + t * (bLon - aLon), aLat + t * (bLat - aLat)] }
    }
  }
  let bearingDeg: number | null = null
  if (best.segment + 1 < route.length) {
    const [aX, aY] = toXy(point(best.segment))
    const [bX, bY] = toXy(point(best.segment + 1))
    if (aX !== bX || aY !== bY) bearingDeg = ((Math.atan2(bX - aX, bY - aY) * 180) / Math.PI + 360) % 360
  }
  if (best.distance > MAX_FOLLOW_DISTANCE_M) {
    return { line: route.slice(fromSegment), segment: fromSegment, distanceM: best.distance, bearingDeg }
  }
  const rest = route.slice(best.segment + 1)
  // Already on the line: no zero-length join from the aircraft to itself.
  const line: TracedRoute =
    best.distance < 0.5 ? [best.point, ...rest] : [[position.lon, position.lat], best.point, ...rest]
  return { line, segment: best.segment, distanceM: best.distance, bearingDeg }
}
