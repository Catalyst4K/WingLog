/**
 * Traces a BeyondATC taxi clearance through the airport's real taxi network, instead of highlighting every segment that
 * shares a taxiway name (winglog-backend's docs/plans/beyondatc-taxi-route-highlight.md). Without it, "taxi to holding
 * point B10, runway 25C, via B8, B" lit up all ~3.9 km of B at VHHH; the real route is ~0.9 km.
 *
 * A shortest path (Dijkstra) over (node, stage) states, where the stage is how far through the cleared taxiway sequence
 * the route has got. Built around these findings in real facility data (VHHH):
 * - Segments join at shared TAXI_POINTs, so identical endpoint coordinates are the graph's nodes.
 * - A clearance names the taxiways driven along, not the short links between them (winglog-backend's
 *   docs/plans/taxi-routing-rules.md): "U, V, H, J" at VHHH was driven U, U1, V, H, H6, J. A stretch of other taxiways between
 *   two cleared ones, no longer than LINK_MAX_M in all, is such a link and costs its plain length, so the route is the shortest
 *   through the cleared taxiways, as ATC planned it (VHHH's "C, D, C, F" takes the link to D and the inside of the bend, where
 *   pricing the link higher kept the route on C and found a D on the roundabout's arcs instead). Any other segment with an
 *   unlisted name is allowed at `OFF_ROUTE_COST_FACTOR` times its length, so the cleared names win but a scenery-naming gap
 *   doesn't break the trace.
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

import { flatDistanceM } from '@shared/geo'
import { buildGraph, startNodes } from './route-graph'
import { drivesTaxiwayAgain } from './route-repeats'
import { newSearch, searchRoute } from './route-search'
import {
  MAX_CLEARANCE_TAXIWAYS,
  MAX_HOLD_FROM_THRESHOLD_M,
  MAX_TRACE_STATES,
  type TaxiTraceRequest,
  type TracedRoute
} from './route-types'
import { furthestBackHold } from './runway-hold'

/**
 * Traces a clearance (traceClearanceRoute). A route that drives a taxiway more often than the clearance names it (rule 10,
 * route-repeats.ts) has doubled back to reach cleared taxiways the aircraft is already past, so the clearance is joined later
 * instead: at the first of its taxiways from which the route keeps to it. With none, the route stands.
 *
 * @param input The clearance, the network and where the aircraft is.
 * @returns The route, or null if it can't be traced, if the clearance names more than MAX_CLEARANCE_TAXIWAYS taxiways, or if the search
 *   takes more than MAX_TRACE_STATES states.
 */
export function traceTaxiRoute(input: TaxiTraceRequest): TracedRoute | null {
  if (input.taxiways.length > MAX_CLEARANCE_TAXIWAYS) return null
  const request = { ...input, budget: input.budget ?? { left: MAX_TRACE_STATES } }
  const route = traceClearanceRoute(request)
  const cleared = [...request.taxiways, ...(request.holdingPoint ? [request.holdingPoint] : [])]
  if (!route || !drivesTaxiwayAgain(route, request.segments, cleared)) return route
  for (let skip = 1; skip < request.taxiways.length; skip++) {
    const later = traceClearanceRoute({ ...request, taxiways: request.taxiways.slice(skip) })
    if (later && !drivesTaxiwayAgain(later, request.segments, cleared)) return later
  }
  return route
}

/**
 * Traces a clearance, strictly first, then accepting where the holding-point taxiway's name stops (see traceOnce).
 *
 * @param request The clearance, the network and where the aircraft is.
 * @returns The route, or null if it can't be traced.
 */
function traceClearanceRoute(request: TaxiTraceRequest): TracedRoute | null {
  // "Hold short of runway 07C" at VHHH (flight 253): the first hold short of the last taxiway was beside another runway.
  if (request.holdShortRunway && !request.onlyAtRunwayHold) {
    const atRunway =
      traceClearanceRoute({ ...request, onlyAtRunwayHold: true, crossingOnly: true }) ??
      traceClearanceRoute({ ...request, onlyAtRunwayHold: true })
    if (atRunway) return atRunway
  }
  if (request.holdingPoint) {
    const plain = { ...request, runwayThreshold: null }
    const first = traceOnce(plain, true)
    // The runway only chooses when the first hold short the search reaches is nowhere near it (EGCC: 1.5 km up the runway). One
    // already beside the threshold stays: EGLL's A1 has hold shorts about as near either side, and the cleared one was the first.
    const end = first?.at(-1)
    const threshold = request.runwayThreshold
    // No first end at all (WSSS's T has no flagged hold short) lets the runway choose too.
    if (
      threshold &&
      (!end || flatDistanceM({ lat: end[1], lon: end[0] }, threshold) > MAX_HOLD_FROM_THRESHOLD_M)
    ) {
      const byRunway = traceOnce(request, true)
      if (byRunway) return atFurthestHold(request, byRunway)
    }
    return first ?? traceOnce(plain, false)
  }
  if (!request.stand) return traceOnce(request, true)
  return traceOnce(request, true) ?? traceOnce({ ...request, stand: null }, true)
}

/**
 * A route that ends at the first hold short near the runway's threshold, moved on to the furthest-back one on that side when there is one.
 *
 * @param request The clearance, with the runway's threshold.
 * @param route The route to the first hold short.
 * @returns The route to the furthest-back hold short, or `route` itself.
 */
function atFurthestHold(request: TaxiTraceRequest, route: TracedRoute): TracedRoute {
  const end = route.at(-1)
  const threshold = request.runwayThreshold
  if (!end || !threshold) return route
  const further = furthestBackHold(request.segments, { lat: end[1], lon: end[0] }, threshold)
  return (further && traceOnce({ ...request, holdAt: further }, true)) ?? route
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
  const { segments, taxiways, holdingPoint, from } = request
  if (taxiways.length === 0) return null
  if (holdingPoint && !segments.some((s) => s.name === holdingPoint)) return null
  // A cleared taxiway the scenery has no segment for can't be followed, so the route goes on to the next one: ZUCK's "via M, G, H1"
  // has only pieces M1 to M4, which don't join into one run (name-alias.ts).
  const present = new Set(segments.map((s) => s.name))
  const followable = taxiways.filter((name) => present.has(name))
  if (followable.length === 0 && !holdingPoint) return null

  const graph = buildGraph(segments, from.lat)
  const starts = startNodes(graph, from, request.headingDeg ?? null)
  if (starts.length === 0) return null

  const search = newSearch({ ...request, taxiways: followable }, graph, strictEnd)
  return search && searchRoute(search, starts, request)
}
