/**
 * How sharply a taxi route turns (winglog-backend's docs/plans/taxi-routing-rules.md, rule 4), shared by the cleared route's trace
 * (route-search.ts) and a re-route's way back to it (route-rejoin.ts), so neither draws a turn an airliner can't make.
 */
import { itemAt } from '@shared/item-at'
import type { Graph } from './route-graph'

/** The most an airliner's heading can change over TURN_WINDOW_M of taxiing: with a turning radius of about 25 m, 60 m of path turns it
 *  137° at most. More than that is a hairpin or a turn on the spot, however finely the network splits it: VHHH flight 253's line lapped
 *  the C/D/F roundabout through turns of 150° and 170°, flight 243's turned round on B9 by 124° then 107° 11 m apart, through a
 *  stand's lead-in lines. A real turn, through a junction's fillet or round VHHH's U1 (180° in 110 m), stays within it. */
export const TURN_WINDOW_MAX_DEG = 135
export const TURN_WINDOW_M = 60
/** What each degree of turning past TURN_WINDOW_MAX_DEG costs, in metres: turning right round on the spot costs about as much as
 *  starting backwards (WRONG_WAY_PENALTY_M), so neither is taken while a drivable way exists, and a line that has to go the other
 *  way from the nose (just pushed back facing away from the cleared route) starts from the aircraft along the cleared way. */
export const TURN_COST_M_PER_DEG = 60

/**
 * @param graph The graph.
 * @param nodes A node before, the node turned at, and a node after.
 * @returns How far the route turns there, degrees; 0 where either segment is too short to have a direction.
 */
export function turnAt(graph: Graph, [from, node, to]: [number, number, number]): number {
  const a = itemAt(graph.nodes, from, 'taxi node')
  const b = itemAt(graph.nodes, node, 'taxi node')
  const c = itemAt(graph.nodes, to, 'taxi node')
  if (graph.distanceM(a.lat, a.lon, b.lat, b.lon) < 0.5 || graph.distanceM(b.lat, b.lon, c.lat, c.lon) < 0.5)
    return 0
  const d = Math.abs((((graph.bearingDeg(from, node) - graph.bearingDeg(node, to)) % 360) + 360) % 360)
  return d > 180 ? 360 - d : d
}

/**
 * How much a route has turned at its points within TURN_WINDOW_M back of where it is, not counting that point itself.
 *
 * @param graph The graph.
 * @param back The route's nodes, latest first (`back[0]` is where it is), as far back as it goes or TURN_WINDOW_M at least.
 * @returns The turning, degrees.
 */
export function turnedBefore(graph: Graph, back: number[]): number {
  let turned = 0
  let distance = 0
  for (let i = 1; i + 1 < back.length && distance < TURN_WINDOW_M; i++) {
    const a = itemAt(graph.nodes, itemAt(back, i - 1, 'route node'), 'taxi node')
    const b = itemAt(graph.nodes, itemAt(back, i, 'route node'), 'taxi node')
    distance += graph.distanceM(a.lat, a.lon, b.lat, b.lon)
    turned += turnAt(graph, [
      itemAt(back, i + 1, 'route node'),
      itemAt(back, i, 'route node'),
      itemAt(back, i - 1, 'route node')
    ])
  }
  return turned
}

/**
 * What going on to the next node costs for turning more than an airliner can (TURN_WINDOW_MAX_DEG over TURN_WINDOW_M).
 *
 * @param graph The graph.
 * @param turned How much the route has turned within TURN_WINDOW_M before the node (turnedBefore).
 * @param nodes The node come from (-1 at the start), the node, and the node gone on to.
 * @returns The cost in metres, 0 within the limit.
 */
export function turnCost(graph: Graph, turned: number, [from, node, to]: [number, number, number]): number {
  const total = turned + (from < 0 ? 0 : turnAt(graph, [from, node, to]))
  return Math.max(0, total - TURN_WINDOW_MAX_DEG) * TURN_COST_M_PER_DEG
}
