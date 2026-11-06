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
