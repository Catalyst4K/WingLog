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

import type { NavdataTaxiSegment } from '@shared/ipc'
import { flatDistanceM, pointToSegmentM } from '@shared/geo'
import { itemAt } from '@shared/item-at'
import { MinQueue } from './min-queue'
import { edgeKey, linksBetween } from './taxi-route-links'
import { drivesTaxiwayAgain } from './taxi-route-repeats'
import { crossingHolds, isHoldShortBeside } from './taxi-runway-crossing'
import { turnCost, turnedBefore, TURN_WINDOW_M } from './taxi-route-turns'
import { furthestBackHold, type RunwayThreshold } from './taxi-runway-hold'

const OFF_ROUTE_COST_FACTOR = 5
/** What taking a link costs on top of its length: where two cleared taxiways meet, the route switches there rather than by a link
 *  (VHHH's "C, F" through the C/D/F roundabout's C arcs, as Callum drove it, not by E and F7 35 m shorter), and of two parallel
 *  taxiways the route stays on the cleared one rather than hopping across and back (flight 250's "D, C, F": D all the way to the
 *  roundabout, not D9 to C). */
export const LINK_PENALTY_M = 200
/** How much more a metre of a cleared taxiway costs while another is still to come, so the route moves on at the first chance when
 *  two ways are otherwise equal. Small against LINK_PENALTY_M: 2.6 km of VHHH's D costs 52 m more, not enough to hop to C by a link. */
const FIRST_CHANCE_BIAS = 0.02
/** What joining the clearance at a later taxiway costs, for each one skipped at its start. An aircraft that can only drive the first
 *  one by a loop joins at the next instead: YBBN flight 225 pushed back facing away from C9, and the line went past B9 and round the
 *  block by C8 to come back down C9, where Callum took C10 and B straight to B9. A first taxiway within reach is still driven. */
export const SKIP_COST_M = 500
/** How far a stand's own point may be from the taxi network's nearest point (its lead-in line
 *  normally ends right at it). */
const MAX_STAND_LINK_M = 150
/** How far the aircraft may be from the nearest taxi-network point to start a trace. */
const MAX_START_DISTANCE_M = 300
/** How far ahead of the nose a network point may be to start the route from. VHHH flight 253: the point nearest the aircraft was
 *  16 m off to the side, on C7's curve west onto C; the curve east, the way it went, started 26 m ahead. In 19 of Callum's 23
 *  recorded taxis a point lies this near ahead; the others (mid-pushback, not yet off the runway) start from the nearest. */
const START_AHEAD_M = 40
/** A cleared taxi route longer than this is almost certainly a wrong trace, not a real one. */
export const MAX_ROUTE_LENGTH_M = 15_000
/** How near the cleared runway's threshold a holding point's hold short is for the runway to say anything about it. A first hold short
 *  farther than this is replaced by the one nearest the threshold, when there is one this near; none this near (an intersection
 *  departure's holding point), or the first already this near, and the first stays. */
export const MAX_HOLD_FROM_THRESHOLD_M = 500
/** When no hold short of the holding-point taxiway is near the cleared runway's threshold, any flagged hold short this near it ends the route
 *  (WSSS "taxi holding point runway 02C via P, T": T has no flagged points, and the holding point is on its T12 branch). */
export const HOLD_NEAR_THRESHOLD_M = 250

/** A runway as a strip on the ground: where it starts, which way it runs, how long and wide. */
export interface RunwayStrip {
  thresholdLat: number
  thresholdLon: number
  headingTrueDeg: number
  lengthM: number
  widthM: number
}

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
  /** The cleared runway's threshold ("taxi to holding point A, runway 05L"). A taxiway running along a runway has a hold short at each
   *  of its entries; the holding point is the one by this threshold, not whichever the search reaches first. Ignored when none is
   *  near it. */
  runwayThreshold?: RunwayThreshold | null
  /** A hold short the route must end at: the furthest-back one beside the cleared runway (see taxi-runway-hold.ts). */
  holdAt?: { lat: number; lon: number } | null
  /** The aircraft's true heading, when it's taxiing under its own power. A first edge pointing
   *  more than WRONG_WAY_DEG away from it costs an extra WRONG_WAY_PENALTY_M, so the
   *  route starts forwards; a U-turn is still taken when it's the only way (dead-end stand
   *  rows). Null or absent: no preference. */
  headingDeg?: number | null
  /** The runway of a "hold short of runway 34R" clearance. The route ends at the first hold short beside it, which can be on
   *  another taxiway than the last cleared one (RKSI flight 239: "via P8, P, hold short of 34R", crossing at P9, not at P's far
   *  end 1.5 km on). */
  holdShortRunway?: RunwayStrip | null
  /** Ends a "hold short of runway" route only at a hold short beside that runway, not at the first hold short of the last taxiway.
   *  Set by the first try; the second drops it for scenery with no hold short beside the runway. */
  onlyAtRunwayHold?: boolean
  /** With onlyAtRunwayHold, ends only where the route crosses the runway (taxi-runway-crossing.ts), not at a hold short on an exit. */
  crossingOnly?: boolean
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

/**
 * Traces a clearance (traceClearanceRoute). A route that drives a taxiway more often than the clearance names it (rule 10,
 * taxi-route-repeats.ts) has doubled back to reach cleared taxiways the aircraft is already past, so the clearance is joined later
 * instead: at the first of its taxiways from which the route keeps to it. With none, the route stands.
 *
 * @param request The clearance, the network and where the aircraft is.
 * @returns The route, or null if it can't be traced.
 */
export function traceTaxiRoute(request: TaxiTraceRequest): TracedRoute | null {
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
  /** The hold short the cleared runway picks for the holding point, or -1 for the first one the search reaches. */
  holdNode: number
  /** The cleared runway's threshold when the route is traced by it, else null. */
  threshold: { lat: number; lon: number } | null
  /** The node the route must end at (`holdAt`), or -1. */
  forcedEnd: number
  /** The runway a hold short is for, or null. */
  holdShortRunway: RunwayStrip | null
  /** Whether a "hold short of runway" route ends only beside that runway. */
  onlyAtRunwayHold: boolean
  /** The hold shorts where the route may cross that runway, or null for any beside it. */
  crossings: Set<number> | null
  /** Per stage, the links on to the next cleared taxiway (edgeKey), worked out when first needed. */
  links: (Set<number> | undefined)[]
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
  const { segments, taxiways, holdingPoint, from } = request
  if (taxiways.length === 0) return null
  if (holdingPoint && !segments.some((s) => s.name === holdingPoint)) return null
  // A cleared taxiway the scenery has no segment for can't be followed, so the route goes on to the next one: ZUCK's "via M, G, H1"
  // has only pieces M1 to M4, which don't join into one run (taxi-name-alias.ts).
  const present = new Set(segments.map((s) => s.name))
  const followable = taxiways.filter((name) => present.has(name))
  if (followable.length === 0 && !holdingPoint) return null

  const graph = buildGraph(segments, from.lat)
  const starts = startNodes(graph, from, request.headingDeg ?? null)
  if (starts.length === 0) return null

  const search = newSearch({ ...request, taxiways: followable }, graph, strictEnd)
  return search && searchRoute(search, starts, request)
}

/**
 * @param graph The graph.
 * @param point A position that is a node of the graph, or null.
 * @returns That node's index, or -1.
 */
function nodeAt(graph: Graph, point: { lat: number; lon: number } | null | undefined): number {
  return point ? (graph.nodeIndex.get(nodeKey(point.lat, point.lon)) ?? -1) : -1
}

/**
 * An empty search for a clearance.
 *
 * @param request The clearance.
 * @param graph The network's graph.
 * @param strictEnd Whether a holding-point route must end at a hold short or dead end.
 * @returns The search, or null when the stand has no link to the network.
 */
function newSearch(request: TaxiTraceRequest, graph: Graph, strictEnd: boolean): TraceSearch | null {
  const { taxiways, holdingPoint, stand } = request
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
    holdNode: holdingPoint ? holdNodeByRunway(graph, holdingPoint, request.runwayThreshold ?? null) : -1,
    threshold: holdingPoint ? (request.runwayThreshold ?? null) : null,
    forcedEnd: nodeAt(graph, request.holdAt),
    ...runwayHold(request, graph),
    links: [],
    strictEnd,
    cost: new Map(),
    realLength: new Map(),
    previous: new Map(),
    queue: new MinQueue()
  }
  return search
}

/**
 * Where a "hold short of runway" route may end.
 *
 * @param request The clearance.
 * @param graph The network's graph.
 * @returns The runway (null for any other clearance), whether only a hold short beside it ends the route, and whether only one where
 *   the route crosses it.
 */
function runwayHold(
  request: TaxiTraceRequest,
  graph: Graph
): Pick<TraceSearch, 'holdShortRunway' | 'onlyAtRunwayHold' | 'crossings'> {
  const runway = request.holdingPoint ? (request.holdShortRunway ?? null) : null
  return {
    holdShortRunway: runway,
    onlyAtRunwayHold: request.onlyAtRunwayHold === true,
    crossings: runway && request.crossingOnly === true ? crossingHolds(graph, runway) : null
  }
}

/**
 * The Dijkstra search itself, from where the route can start (startNodes).
 *
 * @param search The search, empty.
 * @param starts The start nodes, each with its distance from the aircraft.
 * @param request The clearance, for the aircraft's heading and the stand.
 * @returns The route, or null.
 */
function searchRoute(
  search: TraceSearch,
  starts: { node: number; distanceM: number }[],
  request: TaxiTraceRequest
): TracedRoute | null {
  const { cost, realLength, queue } = search
  const last = search.sequence.length - 1
  seedStarts(search, starts, request)

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
    expand(search, [state, stateCost], [node, stage], request.headingDeg ?? null)
  }
  return null
}

/**
 * Puts the route's possible starts in the queue: each start node before the first cleared taxiway, and also part-way through the
 * clearance when the aircraft is already driving along one of its taxiways (VHHH flight 253's "via F7, A, B, W" came at F7's hold
 * short, and EGCC flight 243's full "via VC, V, U, BZ, B, ..." again once on BZ): the route goes on from there rather than back round
 * to drive the ones before it.
 *
 * @param search The search, empty.
 * @param starts The start nodes, each with its distance from the aircraft.
 * @param request The clearance, for the aircraft's position and heading.
 */
function seedStarts(
  search: TraceSearch,
  starts: { node: number; distanceM: number }[],
  request: TaxiTraceRequest
): void {
  const heading = request.headingDeg ?? null
  const under = heading === null ? null : taxiwayUnder(search.graph, request.from, heading)
  const onStage = under === null ? -1 : search.sequence.indexOf(under)
  for (const { node, distanceM } of starts) {
    for (const stage of onStage >= 0 ? [-1, onStage] : [-1]) {
      const startState = stateOf(search, node, stage, -1)
      search.cost.set(startState, distanceM)
      search.realLength.set(startState, 0)
      search.queue.push(startState, distanceM)
    }
  }
}

/**
 * Relaxes every edge out of a state.
 *
 * @param search The search.
 * @param stateAndCost The state and its cost.
 * @param nodeAndStage Its node and stage.
 * @param headingDeg The aircraft's heading, for the first edge, or null.
 */
function expand(
  search: TraceSearch,
  [state, stateCost]: [number, number],
  [node, stage]: [number, number],
  headingDeg: number | null
): void {
  // No immediate U-turns: without this, a clearance whose next taxiway is only touched at a
  // junction gets "satisfied" by driving out along it and straight back.
  const cameFromNode = cameFromNodeOf(search, state)
  const turned = turnedBefore(search.graph, nodesBack(search, state))
  for (const edge of edgesOf(search.graph, node)) {
    if (edge.to === cameFromNode) continue
    const wrongWay = cameFromNode < 0 && isWrongWay(search.graph, node, edge.to, headingDeg)
    const penalty =
      (wrongWay ? WRONG_WAY_PENALTY_M : 0) + turnCost(search.graph, turned, [cameFromNode, node, edge.to])
    for (const [nextStage, edgeCost] of edgeMoves(search, stage, [cameFromNode, node], edge)) {
      relax(
        search,
        state,
        stateOf(search, edge.to, nextStage, node),
        stateCost + edgeCost + penalty,
        edge.lengthM
      )
    }
  }
}

/**
 * The nodes of the route to a state, latest first, back to TURN_WINDOW_M or the start.
 *
 * @param search The search.
 * @param state A state taken from the queue, so the route to it is final.
 * @returns The nodes.
 */
function nodesBack(search: TraceSearch, state: number): number[] {
  const { graph, previous } = search
  const nodes = [nodeOfState(search, state)]
  let distance = 0
  for (let s = previous.get(state); s !== undefined && distance < TURN_WINDOW_M; s = previous.get(s)) {
    const n = nodeOfState(search, s)
    const a = itemAt(graph.nodes, itemAt(nodes, nodes.length - 1, 'route node'), 'taxi node')
    const b = itemAt(graph.nodes, n, 'taxi node')
    distance += graph.distanceM(a.lat, a.lon, b.lat, b.lon)
    nodes.push(n)
  }
  return nodes
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
 * @param from The node the edge leaves, and the node before it (-1 at the start).
 * @param edge The edge.
 * @returns Each [next stage, cost].
 */
function edgeMoves(
  search: TraceSearch,
  stage: number,
  [before, from]: [number, number],
  edge: Edge
): [number, number][] {
  const { sequence } = search
  const moves: [number, number][] = []
  const nextName = sequence[stage + 1]
  if (edge.name !== null && edge.name === nextName) moves.push([stage + 1, edge.lengthM])
  // From the lead-in, the clearance can be joined at a later taxiway, at SKIP_COST_M for each one skipped.
  const later =
    stage < 0 && edge.name !== null && edge.name !== nextName ? sequence.indexOf(edge.name, 1) : -1
  if (later > 0) moves.push([later, edge.lengthM + later * SKIP_COST_M])
  // On a cleared taxiway with another to come, a little more than its length: of two parallel ways that are otherwise equal, the
  // route joins the next taxiway at the first chance, as Callum read "H, J" at VHHH (flight 238: onto J at the first link, H6).
  if (stage >= 0 && edge.name === sequence[stage])
    moves.push([stage, edge.lengthM * (stage < sequence.length - 1 ? 1 + FIRST_CHANCE_BIAS : 1)])
  else if (edge.name === null) moves.push([stage, edge.lengthM])
  else if (edge.name !== nextName) moves.push([stage, offClearanceCost(search, stage, [before, from], edge)])
  return moves
}

/**
 * What a segment of another taxiway than the cleared ones costs.
 *
 * Before the first cleared taxiway, how to get there is the pilot's choice, so a named taxilane costs its plain length
 * like an unnamed lead-in: at 5×, the line zigzagged through every gate lead-in beside B8 instead of straight along it.
 * The same at the other end of a stand clearance, from the last cleared taxiway to the stand: the gate taxilane (B7
 * for N32) isn't named by ATC, so at 5× the line hopped in and out of every gate lead-in along it.
 *
 * @param search The search.
 * @param stage The current stage.
 * @param from The node the edge leaves, and the node before it (-1 at the start).
 * @param edge The edge.
 * @returns The cost.
 */
function offClearanceCost(
  search: TraceSearch,
  stage: number,
  [before, from]: [number, number],
  edge: Edge
): number {
  const { sequence, standNode } = search
  const pilotsChoice = stage < 0 || (standNode >= 0 && stage === sequence.length - 1)
  if (pilotsChoice) return edge.lengthM
  if (!isLink(search, stage, from, edge.to)) return edge.lengthM * OFF_ROUTE_COST_FACTOR
  // Charged once, as the route turns off onto the link; nothing for the last leg to a runway's hold short.
  const turnsOff = stage < sequence.length - 1 && (before < 0 || !isLink(search, stage, before, from))
  return edge.lengthM + (turnsOff ? LINK_PENALTY_M : 0)
}

/**
 * Whether an edge is part of a link from the stage's taxiway to the next cleared one (LINK_MAX_M), or, for a "hold short of runway"
 * clearance's last taxiway, of a last leg from it to the hold short: VHHH flight 253's hold short of 07C was 62 m down F7 from F.
 *
 * @param search The search.
 * @param stage The current stage.
 * @param a The edge's start.
 * @param b Its end.
 * @returns True if it is.
 */
function isLink(search: TraceSearch, stage: number, a: number, b: number): boolean {
  const { graph, sequence } = search
  const last = sequence.length - 1
  if (stage < 0 || stage > last || (stage === last && !search.holdShortRunway)) return false
  let links = search.links[stage]
  if (!links) {
    const from = itemAt(sequence, stage, 'stage')
    links =
      stage === last
        ? linksBetween(graph, from, null)
        : linksBetween(graph, from, itemAt(sequence, stage + 1, 'stage'))
    search.links[stage] = links
  }
  return links.has(edgeKey(graph, a, b))
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
  const edges = edgesOf(graph, node)
  if (endsAtRunwayHold(search, node)) return true
  if (search.onlyAtRunwayHold) return false
  // A hold short on the holding point's own taxiway ends the route however it was reached: RKSI's P runs on through a junction
  // by an unnamed fillet, so insisting on arriving by a P edge sent the line right round the junction to come back into it.
  if (edges.some((e) => e.name === holdingPoint)) {
    if (search.holdNode >= 0) return node === search.holdNode
    if (itemAt(graph.nodes, node, 'taxi node').holdShort) return true
  }
  // The final stage stays the same over unnamed and off-route edges, so check that the edge just driven really was the
  // holding point's. Without this, ZJSY's "holding point A, runway 08, via D, B7, A" ended one unnamed fillet off A, ~150 m
  // past B7: that fillet's far point has no A edge, so it passed for "A's far end".
  if (cameFromNode < 0 || !edgesOf(graph, cameFromNode).some((e) => e.to === node && e.name === holdingPoint))
    return false
  if (search.holdNode >= 0) return false
  // A real far end: nothing else joins here (the runway isn't in the taxi network). Not merely
  // where the name stops: ZJSY's A forks by the runway 08 threshold, and the branch that isn't
  // the hold carries on as A1.
  if (edges.every((e) => e.to === cameFromNode)) return true
  return !strictEnd && !edges.some((e) => e.name === holdingPoint && e.to !== cameFromNode)
}

/**
 * Whether a node is where the cleared runway ends the route: a hold short beside the runway of a "hold short of runway" clearance (where
 * the route crosses it, on the first try), or
 * (with no hold short of the taxiway found by its threshold) one near the threshold.
 *
 * @param search The search.
 * @param node A node index.
 * @returns True if the route ends here.
 */
function endsAtRunwayHold(search: TraceSearch, node: number): boolean {
  const { graph, holdShortRunway, holdNode, threshold, forcedEnd } = search
  if (forcedEnd >= 0) return node === forcedEnd
  if (holdShortRunway && isHoldShortBeside(itemAt(graph.nodes, node, 'taxi node'), holdShortRunway))
    return !search.crossings || search.crossings.has(node)
  return holdNode < 0 && threshold !== null && isHoldShortNear(graph, node, threshold)
}

/**
 * @param graph The graph.
 * @param node A node index.
 * @param threshold The cleared runway's threshold.
 * @returns True if the node is a flagged hold short within HOLD_NEAR_THRESHOLD_M of it.
 */
export function isHoldShortNear(
  graph: Graph,
  node: number,
  threshold: { lat: number; lon: number }
): boolean {
  const n = itemAt(graph.nodes, node, 'taxi node')
  return n.holdShort && graph.distanceM(threshold.lat, threshold.lon, n.lat, n.lon) <= HOLD_NEAR_THRESHOLD_M
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
