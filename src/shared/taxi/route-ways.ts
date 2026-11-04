/**
 * The search both a re-route (route-rejoin.ts) and the pathfinder (fallback.ts) make from the aircraft: the cheapest way to every point,
 * by the point come from, so the cost of a turn can depend on the turn before it (route-turns.ts), starting from the nose so a start
 * behind the heading costs the U-turn it is (winglog-backend's docs/plans/taxi-routing-rules.md, rules 4 and 5).
 */
import { itemAt } from '@shared/item-at'
import { MinQueue } from './min-queue'
import {
  edgesOf,
  isWrongWay,
  WRONG_WAY_PENALTY_M,
  type Edge,
  type Graph,
  type GraphNode
} from './route-graph'
import { turnCost, turnedBefore, TURN_WINDOW_M } from './route-turns'

/** The ways back from the aircraft: each state (a node and the node come from) with its cost and the state before it. */
export interface WaysBack {
  graph: Graph
  cost: Map<number, number>
  previous: Map<number, number>
  /** The state the search stopped at (waysBack's `until`); null when it ran to every state. */
  reached: number | null
}

/** Where the nose points: two points the graph gains for one search, at the aircraft (`nose`) and behind it along its heading
 *  (`tail`), joined from `nose` to every start. The search starts at `nose` come from `tail`, so the turn from the heading onto
 *  the first point counts like any other turn: a start on a junction's fillet curving back the way the aircraft came (VHHH flight
 *  253's arrival), or the nearest point a few metres behind (ZJSY flight 253's departure), costs the U-turn it is. */
export interface Nose {
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
export function addNose(
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

/**
 * @param graph The graph.
 * @param node A node.
 * @param cameFrom The node come from, or -1 at the start.
 * @returns The search state for the node and the node it was come from.
 */
export const stateOf = (graph: Graph, node: number, cameFrom: number): number =>
  (cameFrom + 1) * graph.nodes.length + node
/**
 * @param graph The graph.
 * @param state A search state.
 * @returns The node it is at.
 */
export const nodeOf = (graph: Graph, state: number): number => state % graph.nodes.length
/**
 * @param graph The graph.
 * @param state A search state.
 * @returns The node it was come from, -1 at the start.
 */
export const cameFromOf = (graph: Graph, state: number): number => Math.floor(state / graph.nodes.length) - 1

/**
 * The cheapest way from the aircraft to every node, by the node come from: plain distance, plus WRONG_WAY_PENALTY_M for a first edge
 * against the heading and the cost of turning more than an airliner can (route-turns.ts), from the nose on. No immediate U-turns.
 *
 * @param graph The graph, with the nose added.
 * @param nose The nose (addNose).
 * @param headingDeg The aircraft's heading, or null.
 * @param options What differs from the plain search: `factor` multiplies an edge's length (1 when absent), and `until` stops the
 *   search at the first state on one of its nodes, which is then `reached` (the cheapest such state, as the queue is by cost).
 * @returns Every reached state's cost and the state before it.
 */
export function waysBack(
  graph: Graph,
  { tail, nose }: Nose,
  headingDeg: number | null,
  options: { factor?: (edge: Edge) => number; until?: ReadonlySet<number> } = {}
): WaysBack {
  const ways: WaysBack = { graph, cost: new Map(), previous: new Map(), reached: null }
  const queue = new MinQueue()
  const first = stateOf(graph, nose, tail)
  ways.cost.set(first, 0)
  ways.previous.set(first, stateOf(graph, tail, -1))
  queue.push(first, 0)
  while (queue.size > 0) {
    const [state, stateCost] = queue.pop()
    if (stateCost > (ways.cost.get(state) ?? Infinity)) continue
    const node = nodeOf(graph, state)
    if (options.until?.has(node)) {
      ways.reached = state
      break
    }
    const cameFrom = cameFromOf(graph, state)
    const turned = turnedBefore(graph, nodesBack(ways, state, TURN_WINDOW_M))
    for (const edge of edgesOf(graph, node)) {
      if (edge.to === cameFrom) continue
      const wrongWay = cameFrom === nose && isWrongWay(graph, node, edge.to, headingDeg)
      const next = stateOf(graph, edge.to, node)
      const nextCost =
        stateCost +
        edge.lengthM * (options.factor?.(edge) ?? 1) +
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
export function nodesBack({ graph, previous }: WaysBack, state: number, limitM: number): number[] {
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
