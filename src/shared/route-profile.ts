/**
 * The altitude profile of a planned route (winglog-backend docs/plans/v2-design.md, "Track"): altitude against distance along the route,
 * from the waypoints' planned altitudes. Pure, so it is tested without a screen.
 */
import type { Waypoint } from './route'

/** One fix on the profile. */
export interface ProfilePoint {
  ident: string
  /** Distance along the route from its first point, nautical miles. */
  distanceNm: number
  altitudeFt: number
}

const EARTH_RADIUS_NM = 3440.065
const toRad = (degrees: number): number => (degrees * Math.PI) / 180

/**
 * @param a [longitude, latitude].
 * @param b [longitude, latitude].
 * @returns The great-circle distance between them, nautical miles.
 */
function distanceNm(a: [number, number], b: [number, number]): number {
  const h =
    Math.sin(toRad(b[1] - a[1]) / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(toRad(b[0] - a[0]) / 2) ** 2
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.sqrt(h))
}

/** The route's length and where along it each fix is. */
export interface RouteProfile {
  /** The fixes with a planned altitude (the first and the last stand on the ground at 0 when they have none). */
  points: ProfilePoint[]
  /** The whole route, nautical miles. */
  totalNm: number
  /** Distance from the first point to each waypoint used, in the order the waypoints came, for placing the aircraft. */
  cumulativeNm: number[]
  /** The highest altitude on the profile, feet. */
  maxAltitudeFt: number
}

/**
 * @param waypoints The planned route's waypoints.
 * @returns The profile: each fix with a planned altitude at its distance along the route. A fix with no altitude (zero: navdata legs
 *   carry none) is left out of the line rather than drawn on the ground; the points along the departure runway are not fixes and are
 *   left out, but still count towards the distance. Null for a route of fewer than two points.
 */
export function routeProfile(waypoints: Waypoint[]): RouteProfile | null {
  if (waypoints.length < 2) return null
  const cumulativeNm = waypoints.reduce<number[]>((distances, waypoint, index) => {
    const previous = waypoints[index - 1]
    distances.push(
      previous
        ? (distances[index - 1] ?? 0) + distanceNm([previous.lon, previous.lat], [waypoint.lon, waypoint.lat])
        : 0
    )
    return distances
  }, [])
  const last = waypoints.length - 1
  const points: ProfilePoint[] = []
  waypoints.forEach((waypoint, index) => {
    if (waypoint.runwayPoint) return
    const altitudeFt =
      waypoint.altitudeFt > 0 ? waypoint.altitudeFt : index === 0 || index === last ? 0 : null
    if (altitudeFt !== null)
      points.push({ ident: waypoint.ident, distanceNm: cumulativeNm[index] ?? 0, altitudeFt })
  })
  if (points.length < 2) return null
  return {
    points,
    totalNm: cumulativeNm[last] ?? 0,
    cumulativeNm,
    maxAltitudeFt: Math.max(...points.map((p) => p.altitudeFt))
  }
}

/**
 * @param waypoints The planned route's waypoints.
 * @param cumulativeNm Their distances along the route (RouteProfile.cumulativeNm).
 * @param position [longitude, latitude] of the aircraft.
 * @returns How far along the route the aircraft is, nautical miles: that of the nearest waypoint. Null with no waypoints.
 */
export function distanceAlongRoute(
  waypoints: Waypoint[],
  cumulativeNm: number[],
  position: [number, number]
): number | null {
  let best: { at: number; away: number } | null = null
  waypoints.forEach((waypoint, index) => {
    const away = distanceNm(position, [waypoint.lon, waypoint.lat])
    if (best === null || away < best.away) best = { at: cumulativeNm[index] ?? 0, away }
  })
  return best === null ? null : (best as { at: number; away: number }).at
}

/**
 * @param totalNm The whole route, nautical miles.
 * @param alongNm How far along it the aircraft is.
 * @param spanNm How much of the route to show.
 * @returns The stretch of the route to zoom to: `spanNm` long with the aircraft a fifth of the way in (a little behind it, most of it
 *   ahead), moved to stay inside the route; the whole route when it is no longer than `spanNm`.
 */
export function zoomWindow(
  totalNm: number,
  alongNm: number,
  spanNm: number
): { fromNm: number; toNm: number } {
  if (spanNm >= totalNm) return { fromNm: 0, toNm: totalNm }
  const fromNm = Math.min(Math.max(alongNm - spanNm * 0.2, 0), totalNm - spanNm)
  return { fromNm, toNm: fromNm + spanNm }
}

/** A step climb: where the aircraft leaves its cruise level, and the level it climbs to. */
export interface StepClimb {
  atNm: number
  fromFt: number
  toFt: number
}

/** A cruise level is at least this high; a lower plateau is a departure constraint, not a step. */
const CRUISE_MIN_FT = 10_000
/** A rise smaller than this is the plan's rounding, not a step. */
const STEP_MIN_FT = 900
/** Two fixes at altitudes this close are on one level. */
const LEVEL_TOLERANCE_FT = 100

/**
 * The planned step climbs, found as the plan draws them: a rise to a higher level after at least one leg flown level, high enough to be
 * cruise. The climb to the first cruise level rises through the fixes without a level leg, so it is not one. The waypoints carry no step
 * flag, so this reads the shape (Dispatch has the OFP's own list).
 *
 * @param points The profile's points, in order along the route.
 * @returns Each step climb, at the last fix flown level before the rise.
 */
export function stepClimbs(points: ProfilePoint[]): StepClimb[] {
  const steps: StepClimb[] = []
  for (let i = 2; i < points.length; i++) {
    const [before, level, rise] = [points[i - 2], points[i - 1], points[i]]
    if (!before || !level || !rise) continue
    const isLevel = Math.abs(level.altitudeFt - before.altitudeFt) <= LEVEL_TOLERANCE_FT
    if (isLevel && level.altitudeFt >= CRUISE_MIN_FT && rise.altitudeFt - level.altitudeFt >= STEP_MIN_FT)
      steps.push({ atNm: level.distanceNm, fromFt: level.altitudeFt, toFt: rise.altitudeFt })
  }
  return steps
}

/**
 * @param points The profile's points, in order along the route.
 * @param fromNm Where the stretch starts.
 * @param toNm Where it ends.
 * @returns The points inside the stretch, with a point placed on each edge where the line crosses it, so the line runs to the edges.
 */
export function clipProfile(points: ProfilePoint[], fromNm: number, toNm: number): ProfilePoint[] {
  const altitudeAt = (nm: number): number => {
    const afterIndex = points.findIndex((p) => p.distanceNm >= nm)
    const after = points[afterIndex]
    const before = points[afterIndex - 1]
    if (!after) return points[points.length - 1]?.altitudeFt ?? 0
    if (!before || after.distanceNm === nm) return after.altitudeFt
    const share = (nm - before.distanceNm) / (after.distanceNm - before.distanceNm)
    return before.altitudeFt + share * (after.altitudeFt - before.altitudeFt)
  }
  const inside = points.filter((p) => p.distanceNm > fromNm && p.distanceNm < toNm)
  return [
    { ident: '', distanceNm: fromNm, altitudeFt: altitudeAt(fromNm) },
    ...inside,
    { ident: '', distanceNm: toNm, altitudeFt: altitudeAt(toNm) }
  ]
}
