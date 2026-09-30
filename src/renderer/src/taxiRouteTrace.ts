import type { NavdataTaxiSegment } from '@shared/ipc'

/**
 * Traces a BeyondATC taxi clearance through the airport's real taxi network, instead of
 * highlighting every segment that shares a taxiway name (flightdeck-backend's
 * docs/plans/beyondatc-taxi-route-highlight.md). Real bug that prompted this, VHHH
 * 2026-09-30: "taxi to holding point B10, runway 25C, via B8, B" lit up all ~3.9 km of B
 * across the airport; the real route is ~0.9 km.
 *
 * A shortest path (Dijkstra) over (node, stage) states, where the stage is how far through
 * the cleared taxiway sequence the route has got. Real-data findings it's built around
 * (spiked live against VHHH's facility data, same date):
 * - Segments join at shared TAXI_POINTs, so identical endpoint coordinates are the graph's
 *   nodes.
 * - The sim's own taxiway names don't always match ATC's: VHHH's scenery calls the 137 m
 *   stretch between B and B10 "B12", which the clearance never mentions. Segments with an
 *   unlisted name are allowed, at `OFF_ROUTE_COST_FACTOR` times their length, so the cleared
 *   names always win but a short scenery-naming gap doesn't break the whole trace.
 * - Unnamed segments (junction fillets, stand lead-ins) cost their plain length.
 *
 * Only traced when the clearance ends somewhere concrete: the holding point must itself be a
 * taxiway name in the data with a hold-short point on it (VHHH's "B10" is). Anything else
 * returns null and the caller falls back to highlighting whole taxiways by name — never less
 * than before, and never a guessed end point.
 */

const OFF_ROUTE_COST_FACTOR = 5
/** How far the aircraft may be from the nearest taxi-network point to start a trace. */
const MAX_START_DISTANCE_M = 300
/** A cleared taxi route longer than this is almost certainly a wrong trace, not a real one. */
const MAX_ROUTE_LENGTH_M = 15_000

const METRES_PER_DEGREE = 111_320

export interface TaxiTraceRequest {
  segments: NavdataTaxiSegment[]
  /** The cleared taxiways, in order, as ATC said them ("via B8, B" → ['B8', 'B']). */
  taxiways: string[]
  /** "holding point B10" → 'B10'. */
  holdingPoint: string | null
  from: { lat: number; lon: number }
}

interface Edge {
  to: number
  name: string | null
  lengthM: number
}

/** [lon, lat] pairs, GeoJSON order, from the aircraft's nearest network point to the hold. */
export type TracedRoute = [number, number][]

export function traceTaxiRoute({ segments, taxiways, holdingPoint, from }: TaxiTraceRequest): TracedRoute | null {
  if (!holdingPoint || taxiways.length === 0) return null
  if (!segments.some((s) => s.name === holdingPoint && (s.startHoldShort || s.endHoldShort))) return null

  const cosLat = Math.cos((from.lat * Math.PI) / 180)
  const distanceM = (aLat: number, aLon: number, bLat: number, bLon: number): number =>
    Math.hypot((aLat - bLat) * METRES_PER_DEGREE, (aLon - bLon) * METRES_PER_DEGREE * cosLat)

  const nodeIndex = new Map<string, number>()
  const nodes: { lat: number; lon: number; holdShort: boolean }[] = []
  const edges: Edge[][] = []
  const nodeFor = (lat: number, lon: number, holdShort: boolean): number => {
    const key = `${lat.toFixed(7)},${lon.toFixed(7)}`
    let index = nodeIndex.get(key)
    if (index === undefined) {
      index = nodes.length
      nodeIndex.set(key, index)
      nodes.push({ lat, lon, holdShort })
      edges.push([])
    } else if (holdShort) {
      nodes[index]!.holdShort = true
    }
    return index
  }
  for (const s of segments) {
    const a = nodeFor(s.startLat, s.startLon, s.startHoldShort)
    const b = nodeFor(s.endLat, s.endLon, s.endHoldShort)
    const lengthM = distanceM(s.startLat, s.startLon, s.endLat, s.endLon)
    edges[a]!.push({ to: b, name: s.name, lengthM })
    edges[b]!.push({ to: a, name: s.name, lengthM })
  }

  let start = -1
  let startDistance = Infinity
  for (const [i, node] of nodes.entries()) {
    const d = distanceM(from.lat, from.lon, node.lat, node.lon)
    if (d < startDistance) {
      startDistance = d
      start = i
    }
  }
  if (start < 0 || startDistance > MAX_START_DISTANCE_M) return null

  // The holding point is the route's last leg — "holding point B10 ... via B8, B" is driven
  // as B8 → B → B10.
  const sequence = taxiways.at(-1) === holdingPoint ? taxiways : [...taxiways, holdingPoint]
  const last = sequence.length - 1
  // State = node * (stages + 1) + (stage + 1); stage -1 is the lead-in before the first
  // cleared taxiway.
  const stateOf = (node: number, stage: number): number => node * (sequence.length + 1) + stage + 1
  const cost = new Map<number, number>([[stateOf(start, -1), 0]])
  const realLength = new Map<number, number>([[stateOf(start, -1), 0]])
  const previous = new Map<number, number>()
  const queue = new MinQueue()
  queue.push(stateOf(start, -1), 0)

  while (queue.size > 0) {
    const [state, stateCost] = queue.pop()
    if (stateCost > (cost.get(state) ?? Infinity)) continue
    const node = Math.floor(state / (sequence.length + 1))
    const stage = (state % (sequence.length + 1)) - 1

    const onFinalTaxiway = stage === last && edges[node]!.some((e) => e.name === holdingPoint)
    if (onFinalTaxiway && nodes[node]!.holdShort) {
      if ((realLength.get(state) ?? 0) > MAX_ROUTE_LENGTH_M) return null
      const route: TracedRoute = []
      for (let s: number | undefined = state; s !== undefined; s = previous.get(s)) {
        const n = nodes[Math.floor(s / (sequence.length + 1))]!
        route.push([n.lon, n.lat])
      }
      return route.reverse()
    }

    // No immediate U-turns: without this, a clearance whose next taxiway is only touched at a
    // junction gets "satisfied" by driving out along it and straight back.
    const cameFrom = previous.get(state)
    const cameFromNode = cameFrom === undefined ? -1 : Math.floor(cameFrom / (sequence.length + 1))
    for (const edge of edges[node]!) {
      if (edge.to === cameFromNode) continue
      const moves: [number, number][] = []
      const nextName = sequence[stage + 1]
      if (edge.name !== null && edge.name === nextName) moves.push([stage + 1, edge.lengthM])
      if (edge.name === null || (stage >= 0 && edge.name === sequence[stage])) moves.push([stage, edge.lengthM])
      else if (edge.name !== nextName) moves.push([stage, edge.lengthM * OFF_ROUTE_COST_FACTOR])

      for (const [nextStage, edgeCost] of moves) {
        const next = stateOf(edge.to, nextStage)
        const nextCost = stateCost + edgeCost
        if (nextCost >= (cost.get(next) ?? Infinity)) continue
        cost.set(next, nextCost)
        realLength.set(next, (realLength.get(state) ?? 0) + edge.lengthM)
        previous.set(next, state)
        queue.push(next, nextCost)
      }
    }
  }
  return null
}

/** A small binary min-heap of (state, cost) — VHHH's real network is ~4,400 points, well
 *  past what a linear-scan "queue" handles comfortably per clearance. */
class MinQueue {
  private readonly items: [number, number][] = []

  get size(): number {
    return this.items.length
  }

  push(state: number, cost: number): void {
    const items = this.items
    items.push([state, cost])
    let i = items.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (items[parent]![1] <= items[i]![1]) break
      ;[items[parent], items[i]] = [items[i]!, items[parent]!]
      i = parent
    }
  }

  pop(): [number, number] {
    const items = this.items
    const top = items[0]!
    const end = items.pop()!
    if (items.length > 0) {
      items[0] = end
      let i = 0
      for (;;) {
        const left = i * 2 + 1
        const right = left + 1
        let smallest = i
        if (left < items.length && items[left]![1] < items[smallest]![1]) smallest = left
        if (right < items.length && items[right]![1] < items[smallest]![1]) smallest = right
        if (smallest === i) break
        ;[items[smallest], items[i]] = [items[i]!, items[smallest]!]
        i = smallest
      }
    }
    return top
  }
}
