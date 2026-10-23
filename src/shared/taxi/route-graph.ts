/**
 * The taxi network as a graph for the traces and re-routes (winglog-backend's docs/plans/taxi-routing-rules.md): segments join at shared
 * TAXI_POINTs, so identical endpoint coordinates are the nodes. Where the aircraft is on it, where a route can start, the hold short a
 * runway picks, and the stand's link to it.
 */

import type { NavdataTaxiSegment } from '@shared/ipc'
import { flatDistanceM, pointToSegmentM } from '@shared/geo'
import { itemAt } from '@shared/item-at'
import { MAX_HOLD_FROM_THRESHOLD_M } from './route-types'

/** How far a stand's own point may be from the taxi network's nearest point (its lead-in line
 *  normally ends right at it). */
const MAX_STAND_LINK_M = 150
/** How far the aircraft may be from the nearest taxi-network point to start a trace. */
const MAX_START_DISTANCE_M = 300
/** How far ahead of the nose a network point may be to start the route from. VHHH flight 253: the point nearest the aircraft was
 *  16 m off to the side, on C7's curve west onto C; the curve east, the way it went, started 26 m ahead. In 19 of Callum's 23
 *  recorded taxis a point lies this near ahead; the others (mid-pushback, not yet off the runway) start from the nearest. */
const START_AHEAD_M = 40

export interface Edge {
  to: number
  name: string | null
  lengthM: number
}

/** Above this from the aircraft's heading, a first edge counts as going the wrong way. */
export const WRONG_WAY_DEG = 120
/** An airliner can't turn round in the middle of a taxiway, so starting the wrong way costs more than any sensible way
 *  round; it only wins when there's no way forwards at all (a dead-end stand row). A ×10 factor on the first edge wasn't
 *  enough: with a short first edge the trace re-routed back behind the aircraft (taxi-reroute.md). */
export const WRONG_WAY_PENALTY_M = 3_000

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

export interface GraphNode {
  lat: number
  lon: number
  holdShort: boolean
}

export interface Graph {
  nodeIndex: Map<string, number>
  nodes: GraphNode[]
  edges: Edge[][]
  distanceM: (aLat: number, aLon: number, bLat: number, bLon: number) => number
  bearingDeg: (a: number, b: number) => number
}

/**
 * @param lat A point's latitude.
 * @param lon Its longitude.
 * @returns The point's key in the network: segments that share an endpoint share this key.
 */
export const nodeKey = (lat: number, lon: number): string => `${lat.toFixed(7)},${lon.toFixed(7)}`

/**
 * Segments join at shared TAXI_POINTs, so identical endpoint coordinates are the nodes.
 *
 * @param segments The taxi network.
 * @param refLat The airport's latitude, for the local projection.
 * @returns The graph.
 */
export function buildGraph(segments: NavdataTaxiSegment[], refLat: number): Graph {
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
export function edgesOf(graph: Graph, node: number): Edge[] {
  return itemAt(graph.edges, node, 'taxi node')
}

/**
 * The network point nearest `from`, or -1 beyond MAX_START_DISTANCE_M.
 *
 * @param graph The graph.
 * @param from The position.
 * @returns The node's index, or -1.
 */
export function nearestNode({ nodes, distanceM }: Graph, from: { lat: number; lon: number }): number {
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
 * Where a route can start: every network point within START_AHEAD_M ahead of the nose (within 90° of the heading), each with its
 * distance; with none, or no heading, the nearest point.
 *
 * @param graph The graph.
 * @param from The aircraft's position.
 * @param headingDeg Its true heading, or null.
 * @returns The start points and how far each is from the aircraft; empty when the aircraft is off the network.
 */
export function startNodes(
  graph: Graph,
  from: { lat: number; lon: number },
  headingDeg: number | null
): { node: number; distanceM: number }[] {
  const nearest = nearestNode(graph, from)
  if (nearest < 0) return []
  const ahead: { node: number; distanceM: number }[] = []
  if (headingDeg !== null) {
    const cosLat = Math.cos((from.lat * Math.PI) / 180)
    for (const [i, node] of graph.nodes.entries()) {
      const distanceM = graph.distanceM(from.lat, from.lon, node.lat, node.lon)
      if (distanceM > START_AHEAD_M) continue
      const bearing = (Math.atan2((node.lon - from.lon) * cosLat, node.lat - from.lat) * 180) / Math.PI
      // A point right under the aircraft is neither ahead nor behind.
      if (distanceM < 1 || angleBetweenDeg(bearing, headingDeg) <= 90) ahead.push({ node: i, distanceM })
    }
  }
  return ahead.length > 0 ? ahead : [{ node: nearest, distanceM: 0 }]
}

/** How near a taxiway's line the aircraft must be, and how closely its nose must follow it, to be driving along it. */
const ON_TAXIWAY_M = 25
export const ON_TAXIWAY_DEG = 30

/**
 * The named taxiway the aircraft is driving along: the nearest segment within ON_TAXIWAY_M, if the nose points along it (within
 * ON_TAXIWAY_DEG). Crossing a taxiway at a junction isn't driving along it.
 *
 * @param graph The graph.
 * @param at The aircraft's position.
 * @param headingDeg Its true heading.
 * @returns The taxiway's name, or null.
 */
export function taxiwayUnder(
  graph: Graph,
  at: { lat: number; lon: number },
  headingDeg: number
): string | null {
  const nearest = segmentsUnder(graph, at, headingDeg).sort((x, y) => x.distanceM - y.distanceM)[0]
  return nearest && nearest.offDeg <= ON_TAXIWAY_DEG ? nearest.name : null
}

/**
 * The network segments within ON_TAXIWAY_M of the aircraft.
 *
 * @param graph The graph.
 * @param at The aircraft's position.
 * @param headingDeg Its true heading.
 * @returns Each segment's taxiway name, distance, how far the nose is off its line either way (0-90°), and the end the nose points at.
 */
export function segmentsUnder(
  graph: Graph,
  at: { lat: number; lon: number },
  headingDeg: number
): { name: string | null; distanceM: number; offDeg: number; ahead: number }[] {
  const found: { name: string | null; distanceM: number; offDeg: number; ahead: number }[] = []
  for (const [a, edges] of graph.edges.entries()) {
    const pa = itemAt(graph.nodes, a, 'taxi node')
    for (const edge of edges) {
      if (edge.to < a) continue
      const distanceM = pointToSegmentM(at, pa, itemAt(graph.nodes, edge.to, 'taxi node'))
      if (distanceM >= ON_TAXIWAY_M) continue
      const off = angleBetweenDeg(graph.bearingDeg(a, edge.to), headingDeg)
      found.push({
        name: edge.name,
        distanceM,
        offDeg: Math.min(off, 180 - off),
        ahead: off <= 90 ? edge.to : a
      })
    }
  }
  return found
}

/**
 * The holding point's hold short beside the cleared runway's threshold. "Holding point A, runway 05L" at EGCC: A runs the length of
 * the runway with a hold short at each end, and the one by the 05L numbers is the holding point; the search reaches the far one
 * first when it comes in from that side.
 *
 * @param graph The graph.
 * @param holdingPoint The holding point's taxiway.
 * @param threshold The runway's threshold, or null when unknown.
 * @returns The node's index, or -1 when there is no threshold or no hold short of the taxiway within MAX_HOLD_FROM_THRESHOLD_M of it.
 */
export function holdNodeByRunway(
  graph: Graph,
  holdingPoint: string,
  threshold: { lat: number; lon: number } | null
): number {
  if (!threshold) return -1
  let best = -1
  let bestDistance = MAX_HOLD_FROM_THRESHOLD_M
  for (const [i, node] of graph.nodes.entries()) {
    if (!node.holdShort || !edgesOf(graph, i).some((e) => e.name === holdingPoint)) continue
    const d = graph.distanceM(threshold.lat, threshold.lon, node.lat, node.lon)
    if (d <= bestDistance) {
      bestDistance = d
      best = i
    }
  }
  return best
}

/**
 * The network point a stand links to: the nearest within MAX_STAND_LINK_M (the last one found
 * on a tie), or -1.
 *
 * @param graph The graph.
 * @param stand The stand's position.
 * @returns The node's index, or -1.
 */
export function standLinkNode({ nodes, distanceM }: Graph, stand: { lat: number; lon: number }): number {
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
export function isWrongWay(graph: Graph, from: number, to: number, headingDeg: number | null): boolean {
  return headingDeg !== null && angleBetweenDeg(graph.bearingDeg(from, to), headingDeg) > WRONG_WAY_DEG
}
