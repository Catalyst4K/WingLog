/**
 * Driven tracks with one deviation each, for fuzzing the taxi line's re-routing (winglog-backend docs/plans/taxi-and-second-screen-robustness.md,
 * stage 6d). The recorded taxis show four ways a pilot leaves a cleared route; this makes them on any route, at 8 m/s, one sample a second, the
 * way the sim sends them, so the service can be driven sample by sample as live and its re-routes judged.
 *
 * - `missed-turn`: carries straight on 150 m past a junction the route turns at, then takes the network's shortest way on.
 * - `parallel-taxiway`: takes a different way between two points of the route, not using any edge between them.
 * - `stop-and-turn`: stops, turns 180° on the spot over 20 s, drives back along the route for 80 m, then takes the shortest way on.
 * - `wrong-way-start`: the pushback ends with the nose pointing away from the route, and the aircraft goes the way its nose points.
 */
import { destinationPoint, greatCircleM, initialBearingDeg, toLocalXy } from '../../src/shared/geo'
import { angleBetweenDeg } from '../../src/shared/taxi/route-graph'
import { distToPolyline } from './taxi-geometry'
import { nodeAtPoint, shortestRoute, type GGraph } from './taxi-generate'
import type { LonLat } from './svg'

/** What the sim sends: one sample a second. */
export interface Sample {
  t: number
  lat: number
  lon: number
  headingDeg: number
  groundSpeedMs: number
}

export type Deviation = 'missed-turn' | 'parallel-taxiway' | 'stop-and-turn' | 'wrong-way-start'
export const DEVIATIONS: Deviation[] = ['missed-turn', 'parallel-taxiway', 'stop-and-turn', 'wrong-way-start']

/** How fast the aircraft drives, and how far from the route counts as having left it (taxi-reroute.ts's REROUTE_DISTANCE_M). */
export const SPEED_MS = 8
export const LEFT_ROUTE_M = 40
/** How many samples in a row off the route make a deviation: 6 s at one sample a second. */
const OFF_ROUTE_SAMPLES = 6

/** A stretch of driving, a stop, or a turn on the spot. */
type Leg = { drive: LonLat[] } | { hold: number } | { turnDeg: number; seconds: number }

/** A driven track with one deviation. */
export interface Drive {
  deviation: Deviation
  samples: Sample[]
  /** Which way the nose points when the clearance arrives. */
  startHeadingDeg: number
  /** The index of the first sample that has left the route: more than LEFT_ROUTE_M from it, or, for a stop and turn, driving back along it. */
  leftAtIndex: number
}

/** @returns The route's length, metres. */
function lengthOf(points: LonLat[]): number {
  let length = 0
  for (let i = 1; i < points.length; i++)
    length += greatCircleM(
      { lat: points[i - 1][1], lon: points[i - 1][0] },
      { lat: points[i][1], lon: points[i][0] }
    )
  return length
}

const bearing = (a: LonLat, b: LonLat): number =>
  initialBearingDeg({ lat: a[1], lon: a[0] }, { lat: b[1], lon: b[0] })

/**
 * Samples a sequence of legs at one a second, from a start.
 *
 * @param start Where the aircraft is.
 * @param headingDeg Which way its nose points.
 * @param legs What it does, in order.
 * @returns The samples, the first one standing at the start.
 */
export function sampleLegs(start: LonLat, headingDeg: number, legs: Leg[]): Sample[] {
  let at = start
  let heading = headingDeg
  let t = 0
  const samples: Sample[] = []
  const emit = (point: LonLat, speed: number): void => {
    samples.push({
      t,
      lat: point[1],
      lon: point[0],
      headingDeg: Math.round(heading * 10) / 10,
      groundSpeedMs: speed
    })
    t += 1
  }
  emit(at, 0)
  for (const leg of legs) {
    if ('hold' in leg) {
      for (let s = 0; s < leg.hold; s++) emit(at, 0)
    } else if ('turnDeg' in leg) {
      const from = heading
      for (let s = 1; s <= leg.seconds; s++) {
        heading = (from + (leg.turnDeg * s) / leg.seconds + 360) % 360
        emit(at, 0)
      }
    } else {
      // Drive the polyline: the distance carried over between samples is kept, so the speed is steady round corners.
      let carry = 0
      for (let i = 1; i < leg.drive.length; i++) {
        const a = leg.drive[i - 1]
        const b = leg.drive[i]
        const segment = lengthOf([a, b])
        if (segment === 0) continue
        heading = bearing(a, b)
        let along = SPEED_MS - carry
        while (along <= segment) {
          const p = destinationPoint({ lat: a[1], lon: a[0] }, heading, along)
          at = [p.lon, p.lat]
          emit(at, SPEED_MS)
          along += SPEED_MS
        }
        carry = segment - (along - SPEED_MS)
      }
      const end = leg.drive[leg.drive.length - 1]
      if (end && (at[0] !== end[0] || at[1] !== end[1])) {
        at = end
        emit(at, SPEED_MS)
      }
    }
  }
  return samples
}

/** @returns The route's cumulative distance at each point. */
function cumulative(points: LonLat[]): number[] {
  const out = [0]
  for (let i = 1; i < points.length; i++) out.push(out[i - 1] + lengthOf([points[i - 1], points[i]]))
  return out
}

/** @returns The node of the graph nearest to a point within `limitM`, or -1. */
function nodeNear(graph: GGraph, point: { lat: number; lon: number }, limitM: number): number {
  let best = -1
  let bestM = limitM
  graph.nodes.forEach((n, i) => {
    if (Math.abs(n.lat - point.lat) > 0.002 || Math.abs(n.lon - point.lon) > 0.003) return
    const d = greatCircleM(n, point)
    if (d <= bestM) {
      best = i
      bestM = d
    }
  })
  return best
}

/** @returns The edge between two nodes, or -1. */
function edgeBetween(graph: GGraph, from: number, to: number): number {
  return graph.out[from].find((id) => graph.edges[id].to === to) ?? -1
}

/** @returns The points of a route of edge ids, from its first node. */
function pointsOfPath(graph: GGraph, path: number[]): LonLat[] {
  const first = graph.nodes[graph.edges[path[0]].from]
  return [
    [first.lon, first.lat],
    ...path.map((id): LonLat => [graph.nodes[graph.edges[id].to].lon, graph.nodes[graph.edges[id].to].lat])
  ]
}

/**
 * The legs of a driven track with a deviation, or null when this route has no place for it.
 *
 * @param graph The airport's graph.
 * @param truth The cleared route, [lon, lat], whose points are nodes of the graph.
 * @param deviation Which deviation.
 * @returns What the aircraft does, which way its nose points at the start, and where in the legs it leaves the route.
 */
function legsFor(
  graph: GGraph,
  truth: LonLat[],
  deviation: Deviation
): { legs: Leg[]; startHeadingDeg: number; backAlong?: number } | null {
  const n = truth.length
  const cum = cumulative(truth)
  const total = cum[n - 1]
  const forward = bearing(truth[0], truth[1])
  const end = nodeAtPoint(graph, truth[n - 1])
  const turnAt = (i: number): number =>
    angleBetweenDeg(bearing(truth[i - 1], truth[i]), bearing(truth[i], truth[i + 1]))

  if (deviation === 'wrong-way-start') {
    const heading = (forward + 180) % 360
    const start = nodeAtPoint(graph, truth[0])
    const path = start >= 0 && end >= 0 ? shortestRoute(graph, start, end, heading) : null
    return path ? { legs: [{ drive: pointsOfPath(graph, path) }], startHeadingDeg: heading } : null
  }
  if (deviation === 'missed-turn') {
    for (let i = 1; i < n - 1; i++) {
      if (cum[i] < 100 || total - cum[i] < 250 || turnAt(i) < 45) continue
      const incoming = bearing(truth[i - 1], truth[i])
      const straight = destinationPoint({ lat: truth[i][1], lon: truth[i][0] }, incoming, 150)
      const rejoin = nodeNear(graph, straight, 80)
      const path = rejoin >= 0 && end >= 0 ? shortestRoute(graph, rejoin, end, incoming) : null
      if (!path) continue
      return {
        legs: [
          { drive: [...truth.slice(0, i + 1), [straight.lon, straight.lat]] },
          { drive: pointsOfPath(graph, path) }
        ],
        startHeadingDeg: forward
      }
    }
    return null
  }
  if (deviation === 'parallel-taxiway') {
    for (let i = 1; i < n - 2; i++) {
      for (let j = i + 2; j < n - 1; j++) {
        const span = cum[j] - cum[i]
        if (span < 250) continue
        if (span > 700) break
        const avoid = new Set<number>()
        for (let k = i; k < j; k++) {
          const edge = edgeBetween(graph, nodeAtPoint(graph, truth[k]), nodeAtPoint(graph, truth[k + 1]))
          if (edge >= 0) avoid.add(edge)
        }
        const path = shortestRoute(
          graph,
          nodeAtPoint(graph, truth[i]),
          nodeAtPoint(graph, truth[j]),
          bearing(truth[i - 1], truth[i]),
          avoid
        )
        if (!path) continue
        const alternative = pointsOfPath(graph, path)
        if (lengthOf(alternative) > 3 * span) continue
        return {
          legs: [{ drive: [...truth.slice(0, i + 1), ...alternative.slice(1), ...truth.slice(j + 1)] }],
          startHeadingDeg: forward
        }
      }
    }
    return null
  }
  // stop-and-turn
  for (let i = 1; i < n - 1; i++) {
    if (cum[i] < 150 || total - cum[i] < 300) continue
    let back = i
    while (back > 0 && cum[i] - cum[back] < 80) back -= 1
    const reversed = bearing(truth[back + 1], truth[back])
    const path = shortestRoute(graph, nodeAtPoint(graph, truth[back]), end, reversed)
    if (!path) continue
    return {
      legs: [
        { drive: truth.slice(0, i + 1) },
        { hold: 10 },
        { turnDeg: 180, seconds: 10 },
        { drive: [...truth.slice(back, i + 1).reverse(), ...pointsOfPath(graph, path).slice(1)] }
      ],
      startHeadingDeg: forward,
      backAlong: cum[i]
    }
  }
  return null
}

/**
 * A driven track along a cleared route with one deviation.
 *
 * @param graph The airport's graph.
 * @param truth The cleared route, [lon, lat], whose points are nodes of the graph.
 * @param deviation Which deviation.
 * @returns The track, or null when this route has no place for the deviation.
 */
export function fuzzDrive(graph: GGraph, truth: LonLat[], deviation: Deviation): Drive | null {
  if (truth.length < 3) return null
  const built = legsFor(graph, truth, deviation)
  if (!built) return null
  const first = built.legs[0]
  const startPoint = 'drive' in first ? first.drive[0] : truth[0]
  const samples = sampleLegs(startPoint, built.startHeadingDeg, built.legs)
  const ref = truth[0][1]
  const flatTruth = truth.map(([lon, lat]): [number, number] => {
    const p = toLocalXy({ lat, lon }, ref)
    return [p.x, p.y]
  })
  // Left the route once it stays off it for as long as the service waits before re-routing (taxi-reroute.ts's REROUTE_AFTER_MS, 5 s):
  // a short excursion is not a deviation to re-route for.
  const off = samples.map((s) => {
    const p = toLocalXy({ lat: s.lat, lon: s.lon }, ref)
    return distToPolyline([p.x, p.y], flatTruth) > LEFT_ROUTE_M
  })
  let leftAtIndex = off.findIndex(
    (_, i) => off.slice(i, i + OFF_ROUTE_SAMPLES).filter(Boolean).length === OFF_ROUTE_SAMPLES
  )
  if (deviation === 'stop-and-turn' && built.backAlong !== undefined) {
    // On the route the whole time it drives back along it: it has left the route's direction when it starts back.
    const turned = samples.findIndex(
      (s, i) =>
        samples[i - 1]?.groundSpeedMs === 0 &&
        s.groundSpeedMs > 0 &&
        samples.slice(0, i).some((p) => p.groundSpeedMs > 0)
    )
    leftAtIndex = turned >= 0 ? turned : leftAtIndex
  }
  // A wrong-way start is not a re-route: the first line already starts the way the nose points. Nothing is expected after it.
  if (deviation === 'wrong-way-start') leftAtIndex = Math.max(1, leftAtIndex)
  if (leftAtIndex < 0) return null
  return { deviation, samples, startHeadingDeg: built.startHeadingDeg, leftAtIndex }
}
