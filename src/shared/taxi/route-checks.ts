/**
 * One definition of "a route an aircraft could taxi, for this clearance" (winglog-backend's docs/plans/taxi-and-second-screen-robustness.md,
 * "The checks"). The taxi line's policy uses it to reject a traced line (fallback.ts), and the score and generated-clearance suites report
 * against it, so what the app does and what the tests say about it cannot drift apart.
 *
 * It looks only at the route and the request, never at how the route was made.
 */
import { greatCircleM, initialBearingDeg, pointToSegmentM, toLocalXy } from '@shared/geo'
import type { NavdataTaxiSegment } from '@shared/ipc'
import { drivesTaxiwayAgain } from './route-repeats'
import { TURN_WINDOW_M, TURN_WINDOW_MAX_DEG } from './route-turns'
import { angleBetweenDeg, MAX_ROUTE_LENGTH_M, type TaxiTraceRequest, type TracedRoute } from './route-trace'

/** A point in metres on a flat plane. */
export type Xy = [number, number]

/** The last point must be this close to where the clearance ends. */
export const END_WITHIN_M = 30
/** The first this many metres of the route must point the way the aircraft's nose does. */
export const START_WINDOW_M = 40
/** How far from the aircraft's heading the start of the route may point. */
export const START_MAX_DEG = 90
/** A lap: coming back this close to a place passed at least LAP_MIN_M earlier. */
const LAP_CLOSE_M = 15
const LAP_MIN_M = 150
/** Spacing of the points a lap is looked for among. */
const LAP_STEP_M = 5

/** What can be wrong with a route. */
export type RouteProblem =
  | 'no-route'
  | 'misses-end'
  | 'sharp-turn'
  | 'taxiway-driven-again'
  | 'passes-a-place-twice'
  | 'starts-behind-nose'
  | 'too-long'

/** What the checks need to know about the clearance. */
export type RouteCheckRequest = Pick<
  TaxiTraceRequest,
  'segments' | 'taxiways' | 'holdingPoint' | 'from' | 'stand' | 'headingDeg' | 'holdShortRunway'
> & {
  /** Where the clearance ends, when the caller knows it (the generated suite does). Otherwise it is worked out from the clearance. */
  end?: { lat: number; lon: number } | null
}

/**
 * Points along a line, each with the length of line it stands for and how far along the line it is.
 *
 * @param line The line, in metres.
 * @param stepM About how far apart the points are.
 * @returns The points.
 */
export function pointsAlong(line: Xy[], stepM: number): { p: Xy; m: number; at: number }[] {
  const out: { p: Xy; m: number; at: number }[] = []
  let at = 0
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1]
    const [bx, by] = line[i]
    const len = Math.hypot(bx - ax, by - ay)
    const steps = Math.max(1, Math.ceil(len / stepM))
    for (let k = 0; k < steps; k++) {
      const t = (k + 0.5) / steps
      out.push({ p: [ax + t * (bx - ax), ay + t * (by - ay)], m: len / steps, at: at + t * len })
    }
    at += len
  }
  return out
}

/**
 * @param line A line, in metres.
 * @returns Whether it comes back within 15 m of a place it passed at least 150 m earlier, going the other way or across.
 */
export function passesAPlaceTwice(line: Xy[]): boolean {
  const pts = pointsAlong(line, LAP_STEP_M)
  for (let i = 0; i < pts.length; i++)
    for (let k = i + 1; k < pts.length; k++) {
      if (pts[k].at - pts[i].at < LAP_MIN_M) continue
      if (Math.hypot(pts[k].p[0] - pts[i].p[0], pts[k].p[1] - pts[i].p[1]) < LAP_CLOSE_M) return true
    }
  return false
}

/**
 * @param line A line, in metres.
 * @param windowM The stretch of line the turns are summed over.
 * @returns The most the line turns within any `windowM` of it, in degrees, summed over its points.
 */
export function sharpestTurn(line: Xy[], windowM: number = TURN_WINDOW_M): number {
  const turnAt = (i: number): number => {
    const [a, b, c] = [line[i - 1], line[i], line[i + 1]]
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.5 || Math.hypot(c[0] - b[0], c[1] - b[1]) < 0.5) return 0
    const d = Math.abs(
      (((((Math.atan2(c[0] - b[0], c[1] - b[1]) - Math.atan2(b[0] - a[0], b[1] - a[1])) * 180) / Math.PI) %
        360) +
        360) %
        360
    )
    return d > 180 ? 360 - d : d
  }
  let sharpest = 0
  for (let i = 1; i + 1 < line.length; i++) {
    let turned = 0
    let distance = 0
    for (let k = i; k + 1 < line.length && distance <= windowM; k++) {
      turned += turnAt(k)
      distance += Math.hypot(line[k + 1][0] - line[k][0], line[k + 1][1] - line[k][1])
    }
    sharpest = Math.max(sharpest, turned)
  }
  return sharpest
}

/**
 * @param route A route, [lon, lat] points.
 * @returns The route in metres on a flat plane, and its length.
 */
function flatten(route: TracedRoute): { xy: Xy[]; lengthM: number } {
  const refLat = route[0][1]
  const xy = route.map(([lon, lat]): Xy => {
    const { x, y } = toLocalXy({ lat, lon }, refLat)
    return [x, y]
  })
  let lengthM = 0
  for (let i = 1; i < xy.length; i++) lengthM += Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1])
  return { xy, lengthM }
}

/**
 * @param route A route.
 * @param headingDeg The aircraft's true heading, or null when it isn't known.
 * @returns Whether the first stretch of the route points more than 90° away from the nose.
 */
function startsBehind(route: TracedRoute, headingDeg: number | null | undefined): boolean {
  if (headingDeg === null || headingDeg === undefined) return false
  const start = { lat: route[0][1], lon: route[0][0] }
  let travelled = 0
  for (let i = 1; i < route.length; i++) {
    const to = { lat: route[i][1], lon: route[i][0] }
    travelled = greatCircleM(start, to)
    // A route that never gets this far from its start is too short to point anywhere.
    if (travelled >= START_WINDOW_M || i === route.length - 1) {
      return travelled >= 5 && angleBetweenDeg(initialBearingDeg(start, to), headingDeg) > START_MAX_DEG
    }
  }
  return false
}

/**
 * @param segments The network.
 * @returns The ends of every segment, with whether it is a hold short.
 */
function endpoints(segments: NavdataTaxiSegment[]): { lat: number; lon: number; holdShort: boolean }[] {
  return segments.flatMap((s) => [
    { lat: s.startLat, lon: s.startLon, holdShort: s.startHoldShort },
    { lat: s.endLat, lon: s.endLon, holdShort: s.endHoldShort }
  ])
}

/**
 * Whether the route stops where the clearance ends: at the end the caller gave; else, for a stand, at the stand or the network point
 * nearest it; for a hold short of a runway, at a hold short; for a holding point, at the end of a segment of that taxiway; otherwise on
 * the last cleared taxiway. A clearance with none of those has nothing to check.
 *
 * @param route The route.
 * @param request The clearance and network.
 * @returns True when the route ends too far from where the clearance ends.
 */
function missesEnd(route: TracedRoute, request: RouteCheckRequest): boolean {
  const last = { lat: route[route.length - 1][1], lon: route[route.length - 1][0] }
  const near = (p: { lat: number; lon: number }): boolean => greatCircleM(last, p) <= END_WITHIN_M
  if (request.end) return !near(request.end)
  if (request.stand) {
    const stand = request.stand
    const link = endpoints(request.segments).reduce<{ lat: number; lon: number } | null>(
      (best, p) => (best === null || greatCircleM(stand, p) < greatCircleM(stand, best) ? p : best),
      null
    )
    return !near(stand) && !(link && near(link))
  }
  if (request.holdShortRunway) return !endpoints(request.segments).some((p) => p.holdShort && near(p))
  if (request.holdingPoint) {
    const name = request.holdingPoint
    return !request.segments.some((s) => s.name === name && (near(startOf(s)) || near(endOf(s))))
  }
  const lastTaxiway = request.taxiways.at(-1)
  if (lastTaxiway === undefined) return false
  return !request.segments.some(
    (s) => s.name === lastTaxiway && pointToSegmentM(last, startOf(s), endOf(s)) <= END_WITHIN_M
  )
}

const startOf = (s: NavdataTaxiSegment): { lat: number; lon: number } => ({
  lat: s.startLat,
  lon: s.startLon
})
const endOf = (s: NavdataTaxiSegment): { lat: number; lon: number } => ({ lat: s.endLat, lon: s.endLon })

/**
 * Everything wrong with a route for a clearance.
 *
 * @param route The route, [lon, lat] points from the aircraft to the end.
 * @param request The clearance, the network and where the aircraft is.
 * @returns The problems, none when the route is one an aircraft could taxi.
 */
export function routeProblems(route: TracedRoute, request: RouteCheckRequest): RouteProblem[] {
  if (route.length < 2) return ['no-route']
  const problems: RouteProblem[] = []
  const { xy, lengthM } = flatten(route)
  if (lengthM > MAX_ROUTE_LENGTH_M) problems.push('too-long')
  if (missesEnd(route, request)) problems.push('misses-end')
  if (sharpestTurn(xy) > TURN_WINDOW_MAX_DEG) problems.push('sharp-turn')
  const cleared = [...request.taxiways, ...(request.holdingPoint ? [request.holdingPoint] : [])]
  if (drivesTaxiwayAgain(route, request.segments, cleared)) problems.push('taxiway-driven-again')
  if (passesAPlaceTwice(xy)) problems.push('passes-a-place-twice')
  if (startsBehind(route, request.headingDeg)) problems.push('starts-behind-nose')
  return problems
}
