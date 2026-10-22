/**
 * Where a taxi route meets a runway it was told to hold short of (winglog-backend's docs/plans/taxi-routing-rules.md, rule 8). "Hold
 * short of runway 07C" is held where the route crosses 07C: a hold short beside the runway from which the taxi network runs straight
 * across it to a hold short on the far side. VHHH's crossings of 07C are near either end (F1 and A1, F2 and A2, F7 and A10/A11, F8 and
 * A12, B11 and B10); the hold shorts between them are on its angled high-speed exits, whose paths meet the runway at a shallow angle
 * and go no further. Flight 227's line held short on one of them, F4.
 */

import { itemAt } from '@shared/item-at'
import { MinQueue } from './min-queue'
import type { Graph, GraphNode, RunwayStrip } from './taxi-route-trace'

/** How far past a runway's edge a hold short still counts as beside it (RKSI's sit 75-105 m out). */
const HOLD_SHORT_BESIDE_RUNWAY_M = 150
/** A crossing's way across is at most this many times the straight line between its two hold shorts; an exit's angled way to the far
 *  side, where one exists, is about twice it. */
const CROSSING_MAX_DETOUR = 1.25

/**
 * @param point A position.
 * @param runway The runway.
 * @returns How far along the runway from its threshold the point is, and how far to the right of its centreline (negative: left).
 */
function alongAndAcross(
  point: { lat: number; lon: number },
  runway: RunwayStrip
): { along: number; across: number } {
  const north = (point.lat - runway.thresholdLat) * 111_320
  const east = (point.lon - runway.thresholdLon) * 111_320 * Math.cos((runway.thresholdLat * Math.PI) / 180)
  const heading = (runway.headingTrueDeg * Math.PI) / 180
  return {
    along: north * Math.cos(heading) + east * Math.sin(heading),
    across: east * Math.cos(heading) - north * Math.sin(heading)
  }
}

/**
 * Whether a node is a hold short beside a runway.
 *
 * @param node The node.
 * @param runway The runway.
 * @returns True if it is flagged as a hold short and lies within HOLD_SHORT_BESIDE_RUNWAY_M of the runway's edge.
 */
export function isHoldShortBeside(node: GraphNode, runway: RunwayStrip): boolean {
  if (!node.holdShort) return false
  const { along, across } = alongAndAcross(node, runway)
  return (
    along > -HOLD_SHORT_BESIDE_RUNWAY_M &&
    along < runway.lengthM + HOLD_SHORT_BESIDE_RUNWAY_M &&
    Math.abs(across) <= runway.widthM / 2 + HOLD_SHORT_BESIDE_RUNWAY_M
  )
}

/**
 * The hold shorts beside a runway where the taxi network crosses it: each joined to a hold short on the far side by a way no more
 * than CROSSING_MAX_DETOUR times the straight line between them.
 *
 * @param graph The graph.
 * @param runway The runway.
 * @returns The crossings' hold shorts, by node index.
 */
export function crossingHolds(graph: Graph, runway: RunwayStrip): Set<number> {
  const beside = new Map<number, number>()
  for (const [i, node] of graph.nodes.entries())
    if (isHoldShortBeside(node, runway)) beside.set(i, alongAndAcross(node, runway).across)
  const crossings = new Set<number>()
  const reach = (runway.widthM + 2 * HOLD_SHORT_BESIDE_RUNWAY_M) * CROSSING_MAX_DETOUR
  for (const [from, side] of beside) {
    const a = itemAt(graph.nodes, from, 'taxi node')
    for (const [to, distance] of distancesWithin(graph, from, reach)) {
      const farSide = beside.get(to)
      if (farSide === undefined || farSide * side >= 0) continue
      const b = itemAt(graph.nodes, to, 'taxi node')
      if (distance <= graph.distanceM(a.lat, a.lon, b.lat, b.lon) * CROSSING_MAX_DETOUR) {
        crossings.add(from)
        crossings.add(to)
      }
    }
  }
  return crossings
}

/**
 * @param graph The graph.
 * @param from The node measured from.
 * @param limitM How far to look.
 * @returns How far each node within `limitM` is from `from` over the network.
 */
function distancesWithin(graph: Graph, from: number, limitM: number): Map<number, number> {
  const distance = new Map<number, number>([[from, 0]])
  const queue = new MinQueue()
  queue.push(from, 0)
  while (queue.size > 0) {
    const [node, d] = queue.pop()
    if (d > (distance.get(node) ?? Infinity)) continue
    for (const edge of itemAt(graph.edges, node, 'taxi node')) {
      const next = d + edge.lengthM
      if (next > limitM || next >= (distance.get(edge.to) ?? Infinity)) continue
      distance.set(edge.to, next)
      queue.push(edge.to, next)
    }
  }
  return distance
}
