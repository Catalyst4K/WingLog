/** Where a taxi re-route joins the cleared line again, and how much of the line is left (taxi-reroute.md). */
import type { NavdataTaxiSegment } from '@shared/ipc'
import { toLocalXy } from '@shared/geo'
import { itemAt } from '@shared/item-at'
import { MinQueue } from './min-queue'
import {
  buildGraph,
  edgesOf,
  isWrongWay,
  MAX_ROUTE_LENGTH_M,
  nearestNode,
  nodeKey,
  WRONG_WAY_PENALTY_M,
  type Graph,
  type TracedRoute
} from './taxi-route-trace'

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

  const nodes: number[] = []
  for (let n = best.node; n !== -1; n = itemAt(previous, n, 'taxi node')) nodes.push(n)
  nodes.reverse()
  // The way back ends where it first meets the cleared route, which is followed from there: the shortest way may run on past
  // cleared taxiways to a join near the end, skipping the stretch ATC cleared (EGLL flight 239's last leg).
  const onRoute = firstOnRoute(graph, nodes, route, fromSegment, best.index)
  const path: TracedRoute = nodes.slice(0, onRoute.at + 1).map((n) => {
    const node = itemAt(graph.nodes, n, 'taxi node')
    return [node.lon, node.lat]
  })
  return [...path, ...route.slice(onRoute.index + 1)]
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
