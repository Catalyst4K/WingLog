/**
 * The taxi line's one general fallback (winglog-backend's docs/plans/taxi-pathfinder.md): when a clearance can't be traced through the
 * taxiways it names, find a shortest way from the aircraft to where the clearance ends. It needs only the aircraft's position and the
 * destination, never the taxiway names matching, so a new way for the names to go wrong doesn't need a new patch. Cleared names are
 * preferred where they exist, and the line comes back with how well it matches the clearance, so the map can say it is an estimate.
 */

import type { NavdataTaxiSegment } from '@shared/ipc'
import { itemAt } from '@shared/item-at'
import { MinQueue } from './min-queue'
import { startOfRunwayHolds, type RunwayThreshold } from './taxi-runway-hold'
import {
  buildGraph,
  edgesOf,
  isHoldShortBeside,
  isWrongWay,
  MAX_ROUTE_LENGTH_M,
  nearestNode,
  nodeKey,
  standLinkNode,
  traceTaxiRoute,
  WRONG_WAY_PENALTY_M,
  type Graph,
  type TaxiTraceRequest,
  type TracedRoute
} from './taxi-route-trace'

/** A named taxiway the clearance doesn't mention costs this many times its length, so cleared taxiways win without being required: the
 *  sim's names for a taxiway don't always match ATC's. */
export const OFF_CLEARANCE_COST_FACTOR = 1.5

/** How a line was made: traced through the cleared taxiways in order, or found as a shortest way to where the clearance ends. */
export type TraceKind = 'exact' | 'pathfinder'

/** How well a line matches the clearance's taxiways. */
export interface ClearanceMatch {
  /** The cleared taxiways the data has no segment for. */
  absent: string[]
  /** The cleared taxiways the data has that the line doesn't follow, in order. */
  notFollowed: string[]
}

/** A traced line, how it was made, and how well it matches the clearance. */
export interface TracedClearance {
  route: TracedRoute
  kind: TraceKind
  match: ClearanceMatch
}

/**
 * The names of the taxiways a line follows, in order, one entry per run of the same name.
 *
 * @param segments The taxi network.
 * @param route The line.
 * @returns The named taxiways followed.
 */
function followedNames(segments: NavdataTaxiSegment[], route: TracedRoute): string[] {
  const nameOf = new Map<string, string>()
  for (const s of segments) {
    if (s.name === null) continue
    const a = nodeKey(s.startLat, s.startLon)
    const b = nodeKey(s.endLat, s.endLon)
    nameOf.set(`${a}|${b}`, s.name)
    nameOf.set(`${b}|${a}`, s.name)
  }
  const followed: string[] = []
  for (let i = 1; i < route.length; i++) {
    const [lonA, latA] = itemAt(route, i - 1, 'route point')
    const [lonB, latB] = itemAt(route, i, 'route point')
    const name = nameOf.get(`${nodeKey(latA, lonA)}|${nodeKey(latB, lonB)}`)
    if (name !== undefined && followed.at(-1) !== name) followed.push(name)
  }
  return followed
}

/**
 * Compares a line with the clearance: the cleared taxiways the data has should be followed in the order cleared.
 *
 * @param request The clearance and the network.
 * @param route The line.
 * @returns The cleared taxiways the data lacks, and those it has that the line doesn't follow.
 */
export function matchClearance(request: TaxiTraceRequest, route: TracedRoute): ClearanceMatch {
  const present = new Set(request.segments.map((s) => s.name))
  const cleared = [...request.taxiways, ...(request.holdingPoint ? [request.holdingPoint] : [])].filter(
    (name, i, all) => all.indexOf(name) === i
  )
  const absent = cleared.filter((name) => !present.has(name))
  const followed = followedNames(request.segments, route)
  const notFollowed: string[] = []
  let at = 0
  for (const name of cleared.filter((n) => present.has(n))) {
    const found = followed.indexOf(name, at)
    if (found < 0) notFollowed.push(name)
    else at = found + 1
  }
  return { absent, notFollowed }
}

/**
 * The nodes where the clearance ends, for the shortest-path search to head for: a stand's link, the hold shorts beside a runway to hold
 * short of, or (a holding point the data has no taxiway for) the hold short at the very start of the cleared runway, for a full-length
 * departure.
 *
 * @param graph The network's graph.
 * @param request The clearance.
 * @returns The destination nodes; none when the clearance gives nothing to head for.
 */
function destinationNodes(graph: Graph, request: TaxiTraceRequest): number[] {
  const { holdingPoint, stand, runwayThreshold, holdShortRunway } = request
  if (stand && !holdingPoint) {
    const link = standLinkNode(graph, stand)
    return link >= 0 ? [link] : []
  }
  if (holdShortRunway) {
    return [...graph.nodes.entries()].filter(([, n]) => isHoldShortBeside(n, holdShortRunway)).map(([i]) => i)
  }
  return holdingPoint && runwayThreshold ? startOfRunwayNodes(graph, request.segments, runwayThreshold) : []
}

/**
 * The hold short at the very start of the cleared runway, for a full-length departure.
 *
 * @param graph The network's graph.
 * @param segments The taxi network.
 * @param threshold The cleared runway's threshold.
 * @returns The nodes of the start-of-runway hold shorts, one a side.
 */
function startOfRunwayNodes(
  graph: Graph,
  segments: NavdataTaxiSegment[],
  threshold: RunwayThreshold
): number[] {
  return startOfRunwayHolds(segments, threshold)
    .map((p) => graph.nodeIndex.get(nodeKey(p.lat, p.lon)) ?? -1)
    .filter((n) => n >= 0)
}

/**
 * A way from the aircraft to where the clearance ends, whatever the other cleared taxiways. A holding point the data has is traced to
 * with the trace's own rules for where such a route ends (a hold short by the runway, or the far end of the taxiway where it meets the
 * runway: not simply the first hold short flagged on it, which at EGLL is part-way along A1), but needing only that taxiway: the
 * route there is the shortest from the aircraft. Anything else (a stand, a hold short of a runway, a holding point the data lacks) is a
 * shortest path to where it ends.
 *
 * @param request The clearance, the network and where the aircraft is.
 * @returns The line, or null with no destination, an aircraft off the network, or a way longer than MAX_ROUTE_LENGTH_M.
 */
export function findTaxiPath(request: TaxiTraceRequest): TracedRoute | null {
  const { holdingPoint } = request
  if (holdingPoint && request.segments.some((s) => s.name === holdingPoint)) {
    return traceTaxiRoute({ ...request, taxiways: [holdingPoint] })
  }
  return shortestWayToEnd(request)
}

/**
 * A shortest way from the aircraft to where the clearance ends. Segments on a cleared taxiway cost their length, so do unnamed ones, and
 * any other named taxiway costs OFF_CLEARANCE_COST_FACTOR times that. The first edge pointing back against the aircraft's heading
 * costs WRONG_WAY_PENALTY_M more, as in the trace.
 *
 * @param request The clearance, the network and where the aircraft is.
 * @returns The line, or null with no destination, an aircraft off the network, or a way longer than MAX_ROUTE_LENGTH_M.
 */
function shortestWayToEnd(request: TaxiTraceRequest): TracedRoute | null {
  const graph = buildGraph(request.segments, request.from.lat)
  const start = nearestNode(graph, request.from)
  if (start < 0) return null
  const destinations = new Set(destinationNodes(graph, request))
  if (destinations.size === 0) return null

  const cleared = new Set([...request.taxiways, ...(request.holdingPoint ? [request.holdingPoint] : [])])
  const cost = new Array<number>(graph.nodes.length).fill(Infinity)
  const previous = new Array<number>(graph.nodes.length).fill(-1)
  const queue = new MinQueue()
  cost[start] = 0
  queue.push(start, 0)
  while (queue.size > 0) {
    const [node, nodeCost] = queue.pop()
    if (nodeCost > itemAt(cost, node, 'taxi node')) continue
    if (destinations.has(node)) return routeFrom(graph, previous, node, request)
    for (const edge of edgesOf(graph, node)) {
      const wrongWay =
        node === start && isWrongWay(graph, node, edge.to, request.headingDeg ?? null)
          ? WRONG_WAY_PENALTY_M
          : 0
      const factor = edge.name === null || cleared.has(edge.name) ? 1 : OFF_CLEARANCE_COST_FACTOR
      const next = nodeCost + edge.lengthM * factor + wrongWay
      if (next < itemAt(cost, edge.to, 'taxi node')) {
        cost[edge.to] = next
        previous[edge.to] = node
        queue.push(edge.to, next)
      }
    }
  }
  return null
}

/**
 * @param graph The graph.
 * @param previous Each node's predecessor on its cheapest way (-1 for none).
 * @param end The destination node.
 * @param request The clearance, for the stand appended at a stand clearance's end.
 * @returns The line from the start to `end`, or null when it is longer than MAX_ROUTE_LENGTH_M.
 */
function routeFrom(
  graph: Graph,
  previous: number[],
  end: number,
  request: TaxiTraceRequest
): TracedRoute | null {
  const nodes: number[] = []
  for (let n = end; n !== -1; n = itemAt(previous, n, 'taxi node')) nodes.push(n)
  nodes.reverse()
  let lengthM = 0
  const route: TracedRoute = nodes.map((n, i) => {
    const node = itemAt(graph.nodes, n, 'taxi node')
    if (i > 0) {
      const before = itemAt(graph.nodes, itemAt(nodes, i - 1, 'route node'), 'taxi node')
      lengthM += graph.distanceM(before.lat, before.lon, node.lat, node.lon)
    }
    return [node.lon, node.lat]
  })
  if (lengthM > MAX_ROUTE_LENGTH_M) return null
  if (request.stand && !request.holdingPoint) route.push([request.stand.lon, request.stand.lat])
  return route
}

/**
 * The line for a clearance: traced through the cleared taxiways when that works, otherwise a shortest way to where the clearance ends.
 *
 * @param request The clearance, the network and where the aircraft is.
 * @returns The line, how it was made and how well it matches the clearance; null when neither works.
 */
export function traceWithFallback(request: TaxiTraceRequest): TracedClearance | null {
  // An aircraft already past the clearance's start (Track opened mid-taxi) joins it where it is: taxi-route-trace.ts's SKIP_COST_M.
  const exact = traceTaxiRoute(request)
  if (exact) return { route: exact, kind: 'exact', match: matchClearance(request, exact) }
  const found = findTaxiPath(request)
  return found ? { route: found, kind: 'pathfinder', match: matchClearance(request, found) } : null
}
