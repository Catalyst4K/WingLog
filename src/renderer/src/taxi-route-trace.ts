/**
 * Traces a BeyondATC taxi clearance through the airport's real taxi network, instead of highlighting every segment that
 * shares a taxiway name (winglog-backend's docs/plans/beyondatc-taxi-route-highlight.md). Without it, "taxi to holding
 * point B10, runway 25C, via B8, B" lit up all ~3.9 km of B at VHHH; the real route is ~0.9 km.
 *
 * A shortest path (Dijkstra) over (node, stage) states, where the stage is how far through the cleared taxiway sequence
 * the route has got. Built around these findings in real facility data (VHHH):
 * - Segments join at shared TAXI_POINTs, so identical endpoint coordinates are the graph's nodes.
 * - The sim's taxiway names don't always match ATC's: VHHH's scenery calls the 137 m stretch between B and B10 "B12",
 *   which the clearance never mentions. Segments with an unlisted name are allowed, at `OFF_ROUTE_COST_FACTOR` times
 *   their length, so the cleared names win but a short scenery-naming gap doesn't break the trace.
 * - Unnamed segments (junction fillets, stand lead-ins) cost their plain length. So does any segment before the route
 *   reaches its first cleared taxiway: getting from the stand to the cleared route is the pilot's choice.
 *
 * Where it ends:
 * - **A holding point** ("taxi to holding point A9 … via C9, B9"): along the holding-point taxiway to its hold-short
 *   point, or to its far end if that comes first, where it meets the runway (not in the taxi network, so a dead end;
 *   a point where the name merely stops, like ZJSY's A becoming A1, isn't one). It cannot require a hold-short point:
 *   YBBN's A9 carries its only hold-short flag at the B9 end, where the aircraft *enters* A9.
 * - **A stand** ("taxi to Stand N32 via J, H6, H, V, B"): with the stand's position (the sim's TAXI_PARKING data,
 *   stand-positions.md), on along the network to the point nearest the stand and then the stand itself. Without it, or
 *   if the stand can't be reached that way, where the route joins its last cleared taxiway: the part that's certain.
 * The holding point must be a taxiway name in the data; otherwise null, and the caller falls back to highlighting whole
 * taxiways by name.
 */

import type { NavdataTaxiSegment } from '@shared/ipc'
import { flatDistanceM, toLocalXy } from '@shared/geo'
import { itemAt } from '@shared/item-at'

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
/** An airliner can't turn round in the middle of a taxiway, so starting the wrong way costs more than any sensible way
 *  round; it only wins when there's no way forwards at all (a dead-end stand row). A ×10 factor on the first edge wasn't
 *  enough: with a short first edge the trace re-routed back behind the aircraft (taxi-reroute.md). */
const WRONG_WAY_PENALTY_M = 3_000

/**
 * Smallest angle between two bearings, 0-180.
 *
 * @param a One bearing, degrees.
 * @param b The other.
 * @returns The angle, 0-180.
 */
export function angleBetweenDeg(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360)
  return d > 180 ? 360 - d : d
}

interface GraphNode {
  lat: number
  lon: number
  holdShort: boolean
}

interface Graph {
  nodeIndex: Map<string, number>
  nodes: GraphNode[]
  edges: Edge[][]
  distanceM: (aLat: number, aLon: number, bLat: number, bLon: number) => number
  bearingDeg: (a: number, b: number) => number
}

const nodeKey = (lat: number, lon: number): string => `${lat.toFixed(7)},${lon.toFixed(7)}`

/**
 * Segments join at shared TAXI_POINTs, so identical endpoint coordinates are the nodes.
 *
 * @param segments The taxi network.
 * @param refLat The airport's latitude, for the local projection.
 * @returns The graph.
 */
function buildGraph(segments: NavdataTaxiSegment[], refLat: number): Graph {
  const cosLat = Math.cos((refLat * Math.PI) / 180)
  const distanceM = (aLat: number, aLon: number, bLat: number, bLon: number): number =>
    flatDistanceM({ lat: aLat, lon: aLon }, { lat: bLat, lon: bLon }, refLat)
  const nodeIndex = new Map<string, number>()
  const nodes: GraphNode[] = []
  const edges: Edge[][] = []
  const nodeFor = (lat: number, lon: number, holdShort: boolean): number => {
    const key = nodeKey(lat, lon)
    const existing = nodeIndex.get(key)
    if (existing !== undefined) {
      if (holdShort) itemAt(nodes, existing, 'taxi node').holdShort = true
      return existing
    }
    nodeIndex.set(key, nodes.length)
    nodes.push({ lat, lon, holdShort })
    edges.push([])
    return nodes.length - 1
  }
  for (const s of segments) {
    const a = nodeFor(s.startLat, s.startLon, s.startHoldShort)
    const b = nodeFor(s.endLat, s.endLon, s.endHoldShort)
    const lengthM = distanceM(s.startLat, s.startLon, s.endLat, s.endLon)
    itemAt(edges, a, 'taxi node').push({ to: b, name: s.name, lengthM })
    itemAt(edges, b, 'taxi node').push({ to: a, name: s.name, lengthM })
  }
  const bearingDeg = (a: number, b: number): number => {
    const from = itemAt(nodes, a, 'taxi node')
    const to = itemAt(nodes, b, 'taxi node')
    const dx = (to.lon - from.lon) * cosLat
    const dy = to.lat - from.lat
    return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360
  }
  return { nodeIndex, nodes, edges, distanceM, bearingDeg }
}

/**
 * @param graph The graph.
 * @param node A node index the graph handed out.
 * @returns The node's edges.
 */
function edgesOf(graph: Graph, node: number): Edge[] {
  return itemAt(graph.edges, node, 'taxi node')
}

/**
 * The network point nearest `from`, or -1 beyond MAX_START_DISTANCE_M.
 *
 * @param graph The graph.
 * @param from The position.
 * @returns The node's index, or -1.
 */
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

/**
 * The network point a stand links to: the nearest within MAX_STAND_LINK_M (the last one found
 * on a tie), or -1.
 *
 * @param graph The graph.
 * @param stand The stand's position.
 * @returns The node's index, or -1.
 */
function standLinkNode({ nodes, distanceM }: Graph, stand: { lat: number; lon: number }): number {
  let standNode = -1
  let best = MAX_STAND_LINK_M
  for (const [i, node] of nodes.entries()) {
    const d = distanceM(stand.lat, stand.lon, node.lat, node.lon)
    if (d <= best) {
      best = d
      standNode = i
    }
  }
  return standNode
}

/**
 * Whether the first edge of a route points the wrong way: more than WRONG_WAY_DEG from the
 * aircraft's heading.
 *
 * @param graph The graph.
 * @param from The edge's start.
 * @param to The edge's end.
 * @param headingDeg The aircraft's heading, or null for no preference.
 * @returns True if it does.
 */
function isWrongWay(graph: Graph, from: number, to: number, headingDeg: number | null): boolean {
  return headingDeg !== null && angleBetweenDeg(graph.bearingDeg(from, to), headingDeg) > WRONG_WAY_DEG
}

/**
 * Traces a clearance, strictly first, then accepting where the holding-point taxiway's name stops (see traceOnce).
 *
 * @param request The clearance, the network and where the aircraft is.
 * @returns The route, or null if it can't be traced.
 */
export function traceTaxiRoute(request: TaxiTraceRequest): TracedRoute | null {
  if (request.holdingPoint) return traceOnce(request, true) ?? traceOnce(request, false)
  if (!request.stand) return traceOnce(request, true)
  return traceOnce(request, true) ?? traceOnce({ ...request, stand: null }, true)
}

/**
 * One trace's search over (node, stage) states. State = node * (stages + 1) + (stage + 1);
 * stage -1 is the lead-in before the first cleared taxiway.
 */
interface TraceSearch {
  graph: Graph
  /** The cleared taxiways in driving order, the holding point's last. */
  sequence: string[]
  holdingPoint: string | null
  /** The node the stand links to, or -1 without a stand. */
  standNode: number
  strictEnd: boolean
  /** Each reached state's best cost, real length driven, and the state it was reached from. */
  cost: Map<number, number>
  realLength: Map<number, number>
  previous: Map<number, number>
  queue: MinQueue
}

/**
 * A state is the node, how far through the sequence, and the node just come from. The last is part of the state so that "no
 * immediate U-turn" is exact: with only (node, stage), the cheapest way to reach a state might arrive from the node the best
 * route must leave towards, and that route was then lost (a valid clearance traced the long way round, or not at all).
 *
 * @param search The search.
 * @param node A node.
 * @param stage How far through `sequence`, -1 before the first taxiway.
 * @param cameFrom The node just come from, -1 at the start.
 * @returns The state.
 */
function stateOf(search: TraceSearch, node: number, stage: number, cameFrom: number): number {
  return ((cameFrom + 1) * search.graph.nodes.length + node) * (search.sequence.length + 1) + stage + 1
}

/**
 * @param search The search.
 * @param state A state.
 * @returns Its node.
 */
function nodeOfState(search: TraceSearch, state: number): number {
  return Math.floor(state / (search.sequence.length + 1)) % search.graph.nodes.length
}

/**
 * @param search The search.
 * @param state A state.
 * @returns The node the state was reached from, or -1 for the start.
 */
function cameFromNodeOf(search: TraceSearch, state: number): number {
  return Math.floor(Math.floor(state / (search.sequence.length + 1)) / search.graph.nodes.length) - 1
}

/**
 * `strictEnd`: a holding-point route must end at a hold short or a true dead end. Without one
 * reachable (scenery with no hold-short flags whose taxiway runs into another), the second try
 * accepts where the holding-point taxiway's name stops.
 *
 * @param request The clearance, the network and where the aircraft is.
 * @param strictEnd Whether the route must end at a hold short or dead end.
 * @returns The route, or null.
 */
function traceOnce(request: TaxiTraceRequest, strictEnd: boolean): TracedRoute | null {
  const { segments, taxiways, holdingPoint, from, stand } = request
  if (taxiways.length === 0) return null
  if (holdingPoint && !segments.some((s) => s.name === holdingPoint)) return null

  const graph = buildGraph(segments, from.lat)
  const start = nearestNode(graph, from)
  if (start < 0) return null

  const standNode = !holdingPoint && stand ? standLinkNode(graph, stand) : -1
  if (!holdingPoint && stand && standNode < 0) return null

  // The holding point is the route's last leg — "holding point B10 ... via B8, B" is driven
  // as B8 → B → B10.
  const sequence = !holdingPoint || taxiways.at(-1) === holdingPoint ? taxiways : [...taxiways, holdingPoint]
  const search: TraceSearch = {
    graph,
    sequence,
    holdingPoint,
    standNode,
    strictEnd,
    cost: new Map(),
    realLength: new Map(),
    previous: new Map(),
    queue: new MinQueue()
  }
  return searchRoute(search, start, request)
}

/**
 * The Dijkstra search itself, from the aircraft's nearest node.
 *
 * @param search The search, empty.
 * @param start The aircraft's nearest node.
 * @param request The clearance, for the aircraft's heading and the stand.
 * @returns The route, or null.
 */
function searchRoute(search: TraceSearch, start: number, request: TaxiTraceRequest): TracedRoute | null {
  const { cost, realLength, queue } = search
  const last = search.sequence.length - 1
  const startState = stateOf(search, start, -1, -1)
  cost.set(startState, 0)
  realLength.set(startState, 0)
  queue.push(startState, 0)

  while (queue.size > 0) {
    const [state, stateCost] = queue.pop()
    if (stateCost > (cost.get(state) ?? Infinity)) continue
    const node = nodeOfState(search, state)
    const stage = (state % (search.sequence.length + 1)) - 1

    if (stage === last && isRouteEnd(search, state, node)) {
      return (realLength.get(state) ?? 0) > MAX_ROUTE_LENGTH_M
        ? null
        : routeTo(search, state, request.stand ?? null)
    }

    // No immediate U-turns: without this, a clearance whose next taxiway is only touched at a
    // junction gets "satisfied" by driving out along it and straight back.
    const cameFromNode = cameFromNodeOf(search, state)
    for (const edge of edgesOf(search.graph, node)) {
      if (edge.to === cameFromNode) continue
      const wrongWay =
        state === startState && isWrongWay(search.graph, node, edge.to, request.headingDeg ?? null)
      for (const [nextStage, edgeCost] of edgeMoves(search, stage, edge)) {
        relax(
          search,
          state,
          stateOf(search, edge.to, nextStage, node),
          stateCost + edgeCost + (wrongWay ? WRONG_WAY_PENALTY_M : 0),
          edge.lengthM
        )
      }
    }
  }
  return null
}

/**
 * Records a cheaper way to reach `next`, if this is one.
 *
 * @param search The search.
 * @param state The state the edge leaves.
 * @param next The state it reaches.
 * @param nextCost The cost of reaching `next` this way.
 * @param lengthM The edge's real length.
 */
function relax(search: TraceSearch, state: number, next: number, nextCost: number, lengthM: number): void {
  if (nextCost >= (search.cost.get(next) ?? Infinity)) return
  search.cost.set(next, nextCost)
  search.realLength.set(next, (search.realLength.get(state) ?? 0) + lengthM)
  search.previous.set(next, state)
  search.queue.push(next, nextCost)
}

/**
 * The stages an edge can take the route to from `stage`, and what each costs.
 *
 * @param search The search.
 * @param stage The current stage.
 * @param edge The edge.
 * @returns Each [next stage, cost].
 */
function edgeMoves(search: TraceSearch, stage: number, edge: Edge): [number, number][] {
  const { sequence, standNode } = search
  const moves: [number, number][] = []
  const nextName = sequence[stage + 1]
  if (edge.name !== null && edge.name === nextName) moves.push([stage + 1, edge.lengthM])
  if (edge.name === null || (stage >= 0 && edge.name === sequence[stage])) moves.push([stage, edge.lengthM])
  // Before the first cleared taxiway, how to get there is the pilot's choice, so a named taxilane costs its plain length
  // like an unnamed lead-in: at 5×, the line zigzagged through every gate lead-in beside B8 instead of straight along it.
  // The same at the other end of a stand clearance, from the last cleared taxiway to the stand: the gate taxilane (B7
  // for N32) isn't named by ATC, so at 5× the line hopped in and out of every gate lead-in along it.
  else if (edge.name !== nextName) {
    const pilotsChoice = stage < 0 || (standNode >= 0 && stage === sequence.length - 1)
    moves.push([stage, pilotsChoice ? edge.lengthM : edge.lengthM * OFF_ROUTE_COST_FACTOR])
  }
  return moves
}

/**
 * Whether a state in the final stage is where the route ends.
 *
 * @param search The search.
 * @param state The state.
 * @param node Its node.
 * @returns True if the route ends here.
 */
function isRouteEnd(search: TraceSearch, state: number, node: number): boolean {
  const { graph, holdingPoint, standNode, strictEnd } = search
  if (!holdingPoint) return standNode < 0 || node === standNode
  const cameFromNode = cameFromNodeOf(search, state)
  // The final stage stays the same over unnamed and off-route edges, so check that the edge just driven really was the
  // holding point's. Without this, ZJSY's "holding point A, runway 08, via D, B7, A" ended one unnamed fillet off A, ~150 m
  // past B7: that fillet's far point has no A edge, so it passed for "A's far end".
  if (cameFromNode < 0 || !edgesOf(graph, cameFromNode).some((e) => e.to === node && e.name === holdingPoint))
    return false
  if (itemAt(graph.nodes, node, 'taxi node').holdShort) return true
  // A real far end: nothing else joins here (the runway isn't in the taxi network). Not merely
  // where the name stops: ZJSY's A forks by the runway 08 threshold, and the branch that isn't
  // the hold carries on as A1.
  const edges = edgesOf(graph, node)
  if (edges.every((e) => e.to === cameFromNode)) return true
  return !strictEnd && !edges.some((e) => e.name === holdingPoint && e.to !== cameFromNode)
}

/**
 * @param search The search.
 * @param state The route's end state.
 * @param stand The stand, appended when the route ends at its link node.
 * @returns The route from the start to `state`.
 */
function routeTo(
  search: TraceSearch,
  state: number,
  stand: { lat: number; lon: number } | null
): TracedRoute {
  const route: TracedRoute = []
  for (let s: number | undefined = state; s !== undefined; s = search.previous.get(s)) {
    const n = itemAt(search.graph.nodes, nodeOfState(search, s), 'taxi node')
    route.push([n.lon, n.lat])
  }
  route.reverse()
  if (stand && search.standNode >= 0) route.push([stand.lon, stand.lat])
  return route
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
 * A re-route (winglog-backend's docs/plans/taxi-reroute.md): the shortest total way from the aircraft to the end of the
 * cleared route, joining it at whichever of its points makes that shortest and then following it. Getting to the route
 * costs plain distance on any taxiway; pulling the pilot back to the next cleared taxiway instead pointed back along
 * the route for a whole taxi while the aircraft went the other way to the same hold.
 *
 * Joins only from `fromSegment` on, so never back onto a part already driven. The end (the hold or the stand) is always
 * the original route's. Null when the aircraft is off the network or nothing joins.
 *
 * @param request The network, the cleared route, how far along it the aircraft is, and where it is.
 * @returns The new route, or null.
 */
export function rejoinTaxiRoute({
  segments,
  route,
  fromSegment,
  from,
  headingDeg = null
}: RejoinRequest): TracedRoute | null {
  if (route.length < 2) return null
  const graph = buildGraph(segments, from.lat)
  const start = nearestNode(graph, from)
  if (start < 0) return null

  // Plain-distance Dijkstra over the whole network from the aircraft (a few ms even at VHHH).
  const { cost, previous } = shortestPathsFrom(graph, start, headingDeg)
  const best = bestJoin(graph, route, fromSegment, cost)
  if (best.index < 0 || best.total > MAX_ROUTE_LENGTH_M + WRONG_WAY_PENALTY_M) return null

  const path: TracedRoute = []
  for (let n = best.node; n !== -1; n = itemAt(previous, n, 'taxi node')) {
    const node = itemAt(graph.nodes, n, 'taxi node')
    path.push([node.lon, node.lat])
  }
  path.reverse()
  return [...path, ...route.slice(best.index + 1)]
}

/**
 * Plain-distance shortest paths from one node to every other, with the wrong-way penalty on
 * the first edge.
 *
 * @param graph The graph.
 * @param start The start node.
 * @param headingDeg The aircraft's heading, or null.
 * @returns Each node's cost and the node it was reached from (-1 for none).
 */
function shortestPathsFrom(
  graph: Graph,
  start: number,
  headingDeg: number | null
): { cost: number[]; previous: number[] } {
  const cost = new Array<number>(graph.nodes.length).fill(Infinity)
  const previous = new Array<number>(graph.nodes.length).fill(-1)
  cost[start] = 0
  const queue = new MinQueue()
  queue.push(start, 0)
  while (queue.size > 0) {
    const [node, nodeCost] = queue.pop()
    if (nodeCost > itemAt(cost, node, 'taxi node')) continue
    for (const edge of edgesOf(graph, node)) {
      const wrongWay = node === start && isWrongWay(graph, node, edge.to, headingDeg)
      const nextCost = nodeCost + edge.lengthM + (wrongWay ? WRONG_WAY_PENALTY_M : 0)
      if (nextCost >= itemAt(cost, edge.to, 'taxi node')) continue
      cost[edge.to] = nextCost
      previous[edge.to] = node
      queue.push(edge.to, nextCost)
    }
  }
  return { cost, previous }
}

/**
 * Where to join the cleared route: the point, from `fromSegment` on, with the least distance
 * to it plus distance left along the route after it.
 *
 * @param graph The graph.
 * @param route The cleared route.
 * @param fromSegment The furthest segment driven.
 * @param cost Each node's distance from the aircraft.
 * @returns The point's index in `route`, its node, and the total; index -1 when none joins.
 */
function bestJoin(
  graph: Graph,
  route: TracedRoute,
  fromSegment: number,
  cost: number[]
): { index: number; node: number; total: number } {
  // Distance left along the route from each of its points to the end.
  const remainingFrom: number[] = new Array<number>(route.length).fill(0)
  for (let i = route.length - 2; i >= 0; i--) {
    const [aLon, aLat] = itemAt(route, i, 'route point')
    const [bLon, bLat] = itemAt(route, i + 1, 'route point')
    remainingFrom[i] = itemAt(remainingFrom, i + 1, 'route point') + graph.distanceM(aLat, aLon, bLat, bLon)
  }

  let best = { index: -1, node: -1, total: Infinity }
  for (let i = Math.max(0, fromSegment); i < route.length; i++) {
    const [lon, lat] = itemAt(route, i, 'route point')
    const node = graph.nodeIndex.get(nodeKey(lat, lon))
    if (node === undefined) continue // a stand's own point, not on the network
    const total = itemAt(cost, node, 'taxi node') + itemAt(remainingFrom, i, 'route point')
    if (total < best.total) best = { index: i, node, total }
  }
  return best
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

/** A small binary min-heap of (state, cost) — VHHH's real network is ~4,400 points, well
 *  past what a linear-scan "queue" handles comfortably per clearance. */
class MinQueue {
  private readonly items: [number, number][] = []

  get size(): number {
    return this.items.length
  }

  /**
   * @param state The state.
   * @param cost Its cost.
   */
  push(state: number, cost: number): void {
    const items = this.items
    items.push([state, cost])
    let i = items.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (!this.swapIfLess(i, parent)) break
      i = parent
    }
  }

  /**
   * @returns The cheapest (state, cost), removed.
   * @throws RangeError if the queue is empty.
   */
  pop(): [number, number] {
    const items = this.items
    const top = itemAt(items, 0, 'queue item')
    const end = itemAt(items, items.length - 1, 'queue item')
    items.pop()
    if (items.length > 0) {
      items[0] = end
      let i = 0
      for (;;) {
        const left = i * 2 + 1
        const right = left + 1
        let smallest = i
        if (left < items.length && this.costAt(left) < this.costAt(smallest)) smallest = left
        if (right < items.length && this.costAt(right) < this.costAt(smallest)) smallest = right
        if (smallest === i) break
        this.swap(smallest, i)
        i = smallest
      }
    }
    return top
  }

  /**
   * @param i An index in the heap.
   * @returns That item's cost.
   */
  private costAt(i: number): number {
    return itemAt(this.items, i, 'queue item')[1]
  }

  /**
   * @param a One index.
   * @param b The other.
   */
  private swap(a: number, b: number): void {
    const itemA = itemAt(this.items, a, 'queue item')
    this.items[a] = itemAt(this.items, b, 'queue item')
    this.items[b] = itemA
  }

  /**
   * Swaps a child up past its parent when the child costs less.
   *
   * @param child The child's index.
   * @param parent The parent's index.
   * @returns True if they were swapped.
   */
  private swapIfLess(child: number, parent: number): boolean {
    if (this.costAt(parent) <= this.costAt(child)) return false
    this.swap(parent, child)
    return true
  }
}
