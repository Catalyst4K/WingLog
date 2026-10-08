/**
 * Rules for taxi routes at any airport, without flying there (winglog-backend docs/plans/robustness/scenario-testing.md Part 3).
 *
 * A clearance is generated from a real walk through the airport's cached taxi network: start from a hold short or a stand and walk
 * backwards along taxiways, then read the taxiway names off the walk the way ATC would say them. The app's own `traceClearance`
 * traces that clearance, and each traced route is checked against the rules below. The walk is the route the clearance was made
 * from, so a route that is much longer than it, or doesn't follow the names, or isn't joined up, is a bug in the trace.
 */
import type { NavdataStand, NavdataTaxiSegment } from '../../src/shared/ipc'
import { flatDistanceM } from '../../src/shared/geo'
import { traceClearance, type TaxiClearance } from '../../src/renderer/src/taxi-clearance'
import type { TracedRoute } from '../../src/renderer/src/taxi-route-trace'

/** A traced route may be this many times the walk it was made from (the VHHH B8 zigzag was far over it). */
export const MAX_LENGTH_RATIO = 1.3
/** On top of the ratio, so a very short walk isn't failed over a lead-in's few metres. */
export const LENGTH_SLACK_M = 40
/** How far the aircraft may be from the route's first point (the trace's own limit). */
export const MAX_START_M = 300
/** How far a stand's link node may be from the stand (the trace's own limit). */
export const MAX_STAND_LINK_M = 150

/** Which kind of clearance was generated. */
export type ClearanceKind = 'holding point' | 'runway hold short' | 'stand'

/** A clearance made from a walk, and the walk it was made from. */
export interface GeneratedClearance {
  kind: ClearanceKind
  clearance: TaxiClearance
  stand: NavdataStand | null
  /** The walk's points, [lon, lat], in driving order. */
  walk: [number, number][]
  walkM: number
}

/** One rule a traced route failed. */
export interface RuleFailure {
  rule:
    'traced' | 'starts at the aircraft' | 'connected' | 'follows the names' | 'ends right' | 'not too long'
  detail: string
}

interface Edge {
  to: number
  name: string | null
  lengthM: number
}

interface Node {
  lat: number
  lon: number
  holdShort: boolean
}

/** The taxi network as a graph, built independently of the trace. */
export interface Network {
  nodes: Node[]
  edges: Edge[][]
  refLat: number
}

const nodeKey = (lat: number, lon: number): string => `${lat.toFixed(7)},${lon.toFixed(7)}`

/**
 * @param segments The airport's cached taxi segments.
 * @returns The segments joined at shared end points.
 */
export function buildNetwork(segments: NavdataTaxiSegment[]): Network {
  const refLat = segments[0]?.startLat ?? 0
  const index = new Map<string, number>()
  const nodes: Node[] = []
  const edges: Edge[][] = []
  const nodeFor = (lat: number, lon: number, holdShort: boolean): number => {
    const key = nodeKey(lat, lon)
    const known = index.get(key)
    if (known !== undefined) {
      if (holdShort) nodes[known].holdShort = true
      return known
    }
    index.set(key, nodes.length)
    nodes.push({ lat, lon, holdShort })
    edges.push([])
    return nodes.length - 1
  }
  for (const s of segments) {
    const a = nodeFor(s.startLat, s.startLon, s.startHoldShort)
    const b = nodeFor(s.endLat, s.endLon, s.endHoldShort)
    const lengthM = flatDistanceM(
      { lat: s.startLat, lon: s.startLon },
      { lat: s.endLat, lon: s.endLon },
      refLat
    )
    edges[a].push({ to: b, name: s.name, lengthM })
    edges[b].push({ to: a, name: s.name, lengthM })
  }
  return { nodes, edges, refLat }
}

const distance = (
  network: Network,
  a: { lat: number; lon: number },
  b: { lat: number; lon: number }
): number => flatDistanceM(a, b, network.refLat)

/**
 * @param network The network.
 * @param at A position.
 * @returns The nearest node's index and its distance in metres.
 */
function nearest(network: Network, at: { lat: number; lon: number }): { node: number; metres: number } {
  let best = { node: -1, metres: Infinity }
  for (const [i, node] of network.nodes.entries()) {
    const metres = distance(network, at, node)
    if (metres < best.metres) best = { node: i, metres }
  }
  return best
}

/** Collapses repeated names and drops unnamed stretches: "B8, B8, (fillet), B, B" is "B8, B". */
function namesOf(names: (string | null)[]): string[] {
  const out: string[] = []
  for (const name of names) {
    if (name !== null && name !== '' && out.at(-1) !== name) out.push(name)
  }
  return out
}

/**
 * @param network The network.
 * @param from The first node.
 * @param to The last node.
 * @returns The shortest driving distance between them in metres, Infinity when they aren't joined.
 */
function shortestM(network: Network, from: number, to: number): number {
  const best = new Map<number, number>([[from, 0]])
  const open = new Set([from])
  while (open.size > 0) {
    let node = -1
    for (const candidate of open) {
      if (node < 0 || (best.get(candidate) ?? Infinity) < (best.get(node) ?? Infinity)) node = candidate
    }
    open.delete(node)
    if (node === to) return best.get(node) ?? Infinity
    for (const edge of network.edges[node]) {
      const next = (best.get(node) ?? Infinity) + edge.lengthM
      if (next < (best.get(edge.to) ?? Infinity)) {
        best.set(edge.to, next)
        open.add(edge.to)
      }
    }
  }
  return Infinity
}

/**
 * Walks backwards from a node along the network, never visiting a node twice (a controller doesn't send an aircraft round a
 * loop), until it is at least `targetM` long or has nowhere new to go.
 *
 * @param network The network.
 * @param end The node the walk must finish at.
 * @param targetM How long to make it.
 * @param rand A random number generator, 0 to 1.
 * @returns The nodes in driving order, the edge names between them, and the length; or null when no usable walk starts here.
 */
function walkBackFrom(
  network: Network,
  end: number,
  targetM: number,
  rand: () => number
): { nodes: number[]; names: (string | null)[]; lengthM: number } | null {
  const backwards = [end]
  const names: (string | null)[] = []
  let lengthM = 0
  const visited = new Set([end])
  let current = end
  while (lengthM < targetM) {
    const options = network.edges[current].filter((e) => !visited.has(e.to))
    if (options.length === 0) break
    const edge = options[Math.floor(rand() * options.length)]
    names.push(edge.name)
    lengthM += edge.lengthM
    current = edge.to
    visited.add(current)
    backwards.push(current)
  }
  if (backwards.length < 2) return null
  return { nodes: backwards.reverse(), names: names.reverse(), lengthM }
}

/**
 * Makes `count` clearances at an airport, from random walks that end at a hold short or at a stand.
 *
 * @param network The airport's network.
 * @param stands The airport's stands.
 * @param rand A seeded random number generator, 0 to 1.
 * @param count How many to make.
 * @returns The clearances (fewer when the airport has too little to walk).
 */
export function generateClearances(
  network: Network,
  stands: NavdataStand[],
  rand: () => number,
  count: number
): GeneratedClearance[] {
  const holds = network.nodes.flatMap((n, i) => (n.holdShort ? [i] : []))
  const out: GeneratedClearance[] = []
  for (let attempt = 0; out.length < count && attempt < count * 8; attempt++) {
    const wantStand = stands.length > 0 && rand() < 0.4
    const stand = wantStand ? stands[Math.floor(rand() * stands.length)] : null
    const end = stand
      ? nearest(network, stand)
      : { node: holds[Math.floor(rand() * holds.length)] ?? -1, metres: 0 }
    if (end.node < 0 || (stand && end.metres > MAX_STAND_LINK_M)) continue
    const walk = walkBackFrom(network, end.node, 150 + rand() * 1100, rand)
    if (!walk) continue
    // A controller gives an efficient route, so a walk much longer than the shortest way between its ends isn't one.
    const direct = shortestM(network, walk.nodes[0], end.node)
    if (walk.lengthM > direct * MAX_LENGTH_RATIO) continue
    const runs = namesOf(walk.names)
    if (runs.length === 0) continue
    // A hold short is reached along a named taxiway: that name is what the clearance gives it.
    if ((!stand && walk.names[walk.names.length - 1] === null) || walk.names[walk.names.length - 1] === '')
      continue
    const points = walk.nodes.map((i): [number, number] => [network.nodes[i].lon, network.nodes[i].lat])
    const start = network.nodes[walk.nodes[0]]
    // A couple of metres off the node, as a position reading is; the aircraft is at that node, not beside another.
    const from = { lat: start.lat + (rand() - 0.5) * 0.00004, lon: start.lon + (rand() - 0.5) * 0.00004 }
    if (nearest(network, from).node !== walk.nodes[0]) continue
    const base = { stand: null as string | null, holdShortRunway: null as string | null, from }
    if (stand) {
      out.push({
        kind: 'stand',
        clearance: { ...base, taxiways: runs, holdingPoint: null, stand: stand.name },
        stand,
        walk: points,
        walkM: walk.lengthM
      })
    } else if (rand() < 0.5) {
      const lastRun = runs[runs.length - 1]
      out.push({
        kind: 'holding point',
        clearance: { ...base, taxiways: runs.length > 1 ? runs.slice(0, -1) : runs, holdingPoint: lastRun },
        stand: null,
        walk: points,
        walkM: walk.lengthM
      })
    } else {
      out.push({
        kind: 'runway hold short',
        clearance: { ...base, taxiways: runs, holdingPoint: null, holdShortRunway: '09' },
        stand: null,
        walk: points,
        walkM: walk.lengthM
      })
    }
  }
  return out
}

/**
 * The segment between two route points, if the network has one.
 *
 * @param network The network.
 * @param a One point, [lon, lat].
 * @param b The next point.
 * @returns The edge, or undefined.
 */
function edgeBetween(network: Network, a: [number, number], b: [number, number]): Edge | undefined {
  const from = nearest(network, { lat: a[1], lon: a[0] })
  const to = nearest(network, { lat: b[1], lon: b[0] })
  if (from.metres > 0.5 || to.metres > 0.5) return undefined
  return network.edges[from.node].find((e) => e.to === to.node)
}

/**
 * Whether `needle` appears in `haystack` in order, not necessarily next to each other.
 *
 * @param needle The names the clearance gave.
 * @param haystack The names the route drove along.
 * @returns True if every needle name comes in order.
 */
function inOrder(needle: string[], haystack: string[]): boolean {
  let next = 0
  for (const name of haystack) {
    if (name === needle[next]) next++
  }
  return next === needle.length
}

/**
 * Traces a generated clearance with the app's own code and checks the route against every rule.
 *
 * @param network The airport's network.
 * @param segments The same airport's segments, as the trace takes them.
 * @param generated The clearance and the walk it came from.
 * @param trace The trace to check: the app's own, except in the tests of the rules themselves.
 * @returns The route (null when it couldn't be traced) and the rules it failed.
 */
export function checkClearance(
  network: Network,
  segments: NavdataTaxiSegment[],
  generated: GeneratedClearance,
  trace: typeof traceClearance = traceClearance
): { route: TracedRoute | null; failures: RuleFailure[] } {
  const { clearance, stand, walkM } = generated
  const route = trace(clearance, segments, stand)
  if (!route || route.length === 0) {
    return { route: null, failures: [{ rule: 'traced', detail: 'the trace found no route' }] }
  }
  const failures: RuleFailure[] = []
  const from = clearance.from
  if (from) {
    const gap = distance(network, from, { lat: route[0][1], lon: route[0][0] })
    if (gap > MAX_START_M) {
      failures.push({
        rule: 'starts at the aircraft',
        detail: `the route starts ${Math.round(gap)} m from it`
      })
    }
  }

  // A stand clearance's route finishes with the stand's own position, which is not a network node.
  const standEnd =
    stand !== null &&
    route.length > 1 &&
    route[route.length - 1][0] === stand.lon &&
    route[route.length - 1][1] === stand.lat
  const driven = standEnd ? route.slice(0, -1) : route
  const names: (string | null)[] = []
  let lengthM = 0
  for (let i = 0; i + 1 < driven.length; i++) {
    const edge = edgeBetween(network, driven[i], driven[i + 1])
    if (!edge) {
      failures.push({ rule: 'connected', detail: `point ${i} to ${i + 1} is not a taxi segment` })
      break
    }
    names.push(edge.name)
    lengthM += edge.lengthM
  }

  const wanted =
    clearance.holdingPoint && clearance.taxiways.at(-1) !== clearance.holdingPoint
      ? [...clearance.taxiways, clearance.holdingPoint]
      : clearance.taxiways
  if (!failures.some((f) => f.rule === 'connected') && !inOrder(wanted, namesOf(names))) {
    failures.push({
      rule: 'follows the names',
      detail: `cleared ${wanted.join(', ')}; drove ${namesOf(names).join(', ') || 'no named taxiway'}`
    })
  }

  failures.push(...endFailures(network, driven, standEnd, stand))

  const limit = walkM * MAX_LENGTH_RATIO + LENGTH_SLACK_M
  if (lengthM > limit) {
    failures.push({
      rule: 'not too long',
      detail: `${Math.round(lengthM)} m driven; the clearance's own route is ${Math.round(walkM)} m`
    })
  }
  return { route, failures }
}

/**
 * The "ends right" rule: a stand clearance finishes at the stand, a hold short clearance at a hold short, a dead end, or where
 * the cleared taxiway's name stops (the trace's documented fallback).
 *
 * @param network The network.
 * @param driven The route's network points.
 * @param standEnd Whether the route finished with the stand's position.
 * @param stand The cleared stand, if any.
 * @returns The failures, none when it ends right.
 */
function endFailures(
  network: Network,
  driven: [number, number][],
  standEnd: boolean,
  stand: NavdataStand | null
): RuleFailure[] {
  const last = driven[driven.length - 1]
  const lastNode = nearest(network, { lat: last[1], lon: last[0] })
  if (stand) {
    if (!standEnd) return [{ rule: 'ends right', detail: 'the route does not finish at the stand' }]
    const metres = distance(network, stand, { lat: last[1], lon: last[0] })
    return metres > MAX_STAND_LINK_M
      ? [
          {
            rule: 'ends right',
            detail: `the route reaches the network ${Math.round(metres)} m from the stand`
          }
        ]
      : []
  }
  const node = network.nodes[lastNode.node]
  const deadEnd = new Set(network.edges[lastNode.node].map((e) => e.to)).size <= 1
  const previous = driven.length > 1 ? driven[driven.length - 2] : null
  const lastEdge = previous ? edgeBetween(network, previous, last) : undefined
  const nameStops =
    lastEdge?.name != null &&
    !network.edges[lastNode.node].some((e) => e.name === lastEdge.name && !samePlace(network, e.to, previous))
  return node.holdShort || deadEnd || nameStops
    ? []
    : [
        {
          rule: 'ends right',
          detail: 'the route stops mid-taxiway: not at a hold short, a dead end or the end of the name'
        }
      ]
}

/**
 * @param network The network.
 * @param node A node index.
 * @param at A route point, or null.
 * @returns Whether the node is that point.
 */
function samePlace(network: Network, node: number, at: [number, number] | null): boolean {
  return at !== null && distance(network, network.nodes[node], { lat: at[1], lon: at[0] }) < 0.5
}
