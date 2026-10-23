/**
 * The search a taxi trace runs: a shortest path (Dijkstra) over (node, stage) states, where the stage is how far through the cleared
 * taxiway sequence the route has got, priced by the rules in winglog-backend's docs/plans/taxi-routing-rules.md. `route-trace.ts` decides
 * which searches to run for a clearance; this is one of them.
 */

import { itemAt } from '@shared/item-at'
import { MinQueue } from './min-queue'
import {
  edgesOf,
  holdNodeByRunway,
  isWrongWay,
  nodeKey,
  standLinkNode,
  taxiwayUnder,
  WRONG_WAY_PENALTY_M,
  type Edge,
  type Graph
} from './route-graph'
import { edgeKey, linksBetween } from './route-links'
import {
  HOLD_NEAR_THRESHOLD_M,
  MAX_ROUTE_LENGTH_M,
  SKIP_COST_M,
  type RunwayStrip,
  type TaxiTraceRequest,
  type TracedRoute
} from './route-types'
import { crossingHolds, isHoldShortBeside } from './runway-crossing'
import { turnCost, turnedBefore, TURN_WINDOW_M } from './route-turns'

const OFF_ROUTE_COST_FACTOR = 5
/** What taking a link costs on top of its length: where two cleared taxiways meet, the route switches there rather than by a link
 *  (VHHH's "C, F" through the C/D/F roundabout's C arcs, as Callum drove it, not by E and F7 35 m shorter), and of two parallel
 *  taxiways the route stays on the cleared one rather than hopping across and back (flight 250's "D, C, F": D all the way to the
 *  roundabout, not D9 to C). */
export const LINK_PENALTY_M = 200
/** How much more a metre of a cleared taxiway costs while another is still to come, so the route moves on at the first chance when
 *  two ways are otherwise equal. Small against LINK_PENALTY_M: 2.6 km of VHHH's D costs 52 m more, not enough to hop to C by a link. */
const FIRST_CHANCE_BIAS = 0.02

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
export function newSearch(request: TaxiTraceRequest, graph: Graph, strictEnd: boolean): TraceSearch | null {
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
export function searchRoute(
  search: TraceSearch,
  starts: { node: number; distanceM: number }[],
  request: TaxiTraceRequest
): TracedRoute | null {
  const { cost, realLength, queue } = search
  const last = search.sequence.length - 1
  seedStarts(search, starts, request)

  while (queue.size > 0) {
    if (request.budget && request.budget.left-- <= 0) return null
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
function isHoldShortNear(graph: Graph, node: number, threshold: { lat: number; lon: number }): boolean {
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
