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
  nodeAheadOnTaxiway,
  nodeKey,
  startNodes,
  WRONG_WAY_PENALTY_M,
  type Graph,
  type GraphNode,
  type RunwayStrip,
  type TracedRoute
} from './taxi-route-trace'
import { holdsOnSide } from './taxi-runway-crossing'
import { turnCost, turnedBefore, TURN_WINDOW_M } from './taxi-route-turns'

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
 * than an airliner can, from the nose on, on the way and onto the cleared route (rule 4, taxi-route-turns.ts).
 *
 * Joins only from `fromSegment` on, so never back onto a part already driven. The end (the hold or the stand) is the original
 * route's, or for a "hold short of runway" route another hold short of that runway on the same side, if nearer (holdsOnSide).
 * Null when the aircraft is off the network or nothing joins.
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
  const best = bestJoin(graph, route, fromSegment, ways)
  const holds = holdShortRunway ? holdsOnSide(graph, holdShortRunway, { lat: last[1], lon: last[0] }) : null
  const hold = holds ? nearestHold(ways, holds) : null
  if (hold && hold.total < best.total) return fromAircraft(graph, from, pathTo(graph, ways, hold.state))
  if (best.index < 0 || best.total > MAX_ROUTE_LENGTH_M + WRONG_WAY_PENALTY_M) return null

  // Without the nose's two points.
  const nodes = nodesBack(ways, best.state, Infinity).reverse().slice(2)
  // The way back ends where it first meets the cleared route, which is followed from there: the shortest way may run on past
  // cleared taxiways to a join near the end, skipping the stretch ATC cleared (EGLL flight 239's last leg).
  const onRoute = firstOnRoute(graph, nodes, route, fromSegment, best.index)
  const path: TracedRoute = nodes.slice(0, onRoute.at + 1).map((n) => {
    const node = itemAt(graph.nodes, n, 'taxi node')
    return [node.lon, node.lat]
  })
  return fromAircraft(graph, from, [...path, ...route.slice(onRoute.index + 1)])
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

/** Where the nose points: two points the graph gains for one search, behind the aircraft along its heading (`tail`) and just behind
 *  it (`nose`), joined from `nose` to every start. The search starts at `nose` come from `tail`, so the turn from the heading onto
 *  the first point counts like any other turn: a start on a junction's fillet curving back the way the aircraft came (VHHH flight
 *  253's arrival) costs the U-turn it is. */
interface Nose {
  tail: number
  nose: number
}

/** How far behind the aircraft `nose` is, and `tail` behind that: enough to give the heading a direction (turnAt). */
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
  const tail = graph.nodes.push(back(2 * NOSE_BACK_M)) - 1
  graph.edges.push([])
  const nose = graph.nodes.push(back(NOSE_BACK_M)) - 1
  graph.edges.push(starts.map(({ node, distanceM }) => ({ to: node, name: null, lengthM: distanceM })))
  return { tail, nose }
}

const stateOf = (graph: Graph, node: number, cameFrom: number): number =>
  (cameFrom + 1) * graph.nodes.length + node
const nodeOf = (graph: Graph, state: number): number => state % graph.nodes.length
const cameFromOf = (graph: Graph, state: number): number => Math.floor(state / graph.nodes.length) - 1

/**
 * The cheapest way from the aircraft to every node, by the node come from: plain distance, plus WRONG_WAY_PENALTY_M for a first edge
 * against the heading and the cost of turning more than an airliner can (taxi-route-turns.ts), from the nose on. No immediate U-turns.
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
 * Where to join the cleared route: the reached state on one of its points, from `fromSegment` on, with the least cost to it plus the
 * distance left along the route after it plus the cost of turning onto it.
 *
 * @param graph The graph.
 * @param route The cleared route.
 * @param fromSegment The furthest segment driven.
 * @param ways The ways back from the aircraft.
 * @returns The point's index in `route`, the state reaching it, and the total; index -1 when none joins.
 */
function bestJoin(
  graph: Graph,
  route: TracedRoute,
  fromSegment: number,
  ways: WaysBack
): { index: number; state: number; total: number } {
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

  let best = { index: -1, state: -1, total: Infinity }
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
      const total = cost + itemAt(remainingFrom, i, 'route point') + turning
      // Of equal ways (one starting at the point under the aircraft, one at the next), the one keeping more of the cleared route.
      if (total < best.total - 0.01 || (total <= best.total + 0.01 && i < best.index))
        best = { index: i, state, total }
    }
  }
  return best
}

/**
 * The nearest of some hold shorts the way back reaches.
 *
 * @param ways The ways back.
 * @param holds The hold shorts, by node index.
 * @returns The state reaching it and its cost, or null when none is reached.
 */
function nearestHold(ways: WaysBack, holds: Set<number>): { state: number; total: number } | null {
  let best: { state: number; total: number } | null = null
  for (const [state, cost] of ways.cost)
    if (holds.has(nodeOf(ways.graph, state)) && cost < (best?.total ?? MAX_ROUTE_LENGTH_M))
      best = { state, total: cost }
  return best
}

/**
 * @param graph The graph.
 * @param ways The ways back.
 * @param state A reached state.
 * @returns The way to it from the aircraft, without the nose's two points.
 */
function pathTo(graph: Graph, ways: WaysBack, state: number): TracedRoute {
  return nodesBack(ways, state, Infinity)
    .reverse()
    .slice(2)
    .map((n) => {
      const node = itemAt(graph.nodes, n, 'taxi node')
      return [node.lon, node.lat]
    })
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
