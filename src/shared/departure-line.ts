/**
 * The planned line's start on the departure runway (winglog-backend docs/plans/v2-design.md, "The map", D10): from the runway's start, along
 * its centreline to its far end, then on to the first fix of the departure. Pure, so the window and the main process draw the same line.
 */
import type { Waypoint } from './route'

/** What the line needs of the departure runway: its start (the end the aircraft takes off from), its heading and its length. */
export interface DepartureRunway {
  ident: string
  headingTrueDeg: number
  lengthM: number
  thresholdLat: number
  thresholdLon: number
}

/** How far past the runway end the centreline is drawn on when the first fix lies behind it, nautical miles (D10). */
export const CLIMB_OUT_NM = 2
/** How far the first fix's bearing from the runway end may differ from the runway's heading before the line would fold back over it, degrees. */
export const FOLD_BACK_DEG = 90

const METRES_PER_NM = 1852
const EARTH_RADIUS_M = 6_371_000
const toRad = (degrees: number): number => (degrees * Math.PI) / 180
const toDeg = (radians: number): number => (radians * 180) / Math.PI

/**
 * @param from [longitude, latitude] to start from.
 * @param bearingDeg True bearing, degrees.
 * @param distanceM Distance, metres.
 * @returns [longitude, latitude] of the point that far along that bearing on the great circle.
 */
function pointAlong(from: [number, number], bearingDeg: number, distanceM: number): [number, number] {
  const lat = toRad(from[1])
  const lng = toRad(from[0])
  const bearing = toRad(bearingDeg)
  const angular = distanceM / EARTH_RADIUS_M
  const pointLat = Math.asin(
    Math.sin(lat) * Math.cos(angular) + Math.cos(lat) * Math.sin(angular) * Math.cos(bearing)
  )
  const pointLng =
    lng +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(lat),
      Math.cos(angular) - Math.sin(lat) * Math.sin(pointLat)
    )
  // Longitude back into -180 to 180 (a runway near the antimeridian runs across it).
  return [((toDeg(pointLng) + 540) % 360) - 180, toDeg(pointLat)]
}

/**
 * @param from [longitude, latitude].
 * @param to [longitude, latitude].
 * @returns The initial true bearing from one to the other, degrees from 0 to 360.
 */
function bearingTo(from: [number, number], to: [number, number]): number {
  const lat1 = toRad(from[1])
  const lat2 = toRad(to[1])
  const dLng = toRad(to[0] - from[0])
  const y = Math.sin(dLng) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

/**
 * @param a A bearing, degrees.
 * @param b Another bearing, degrees.
 * @returns How far apart they are, degrees from 0 to 180.
 */
function bearingDifference(a: number, b: number): number {
  const difference = Math.abs(a - b) % 360
  return difference > 180 ? 360 - difference : difference
}

/**
 * The points the planned line starts with: the runway's start and its far end. When the first fix lies behind the runway end (the
 * bearing from the end to it is more than 90 degrees off the runway's heading: vectors, no SID, or a first fix the other way) a straight
 * line from the end would fold back over the runway, so the centreline is carried on for a short climb-out instead, and the line resumes
 * from there. No turn is invented.
 *
 * @param runway The departure runway.
 * @param firstFix [longitude, latitude] of the first fix after the runway, or null when there is none.
 * @returns The line's first points, marked as the runway's, not fixes.
 */
export function departureLine(runway: DepartureRunway, firstFix: [number, number] | null): Waypoint[] {
  const start: [number, number] = [runway.thresholdLon, runway.thresholdLat]
  const end = pointAlong(start, runway.headingTrueDeg, runway.lengthM)
  const points = [start, end]
  const foldsBack =
    firstFix !== null && bearingDifference(bearingTo(end, firstFix), runway.headingTrueDeg) > FOLD_BACK_DEG
  if (foldsBack) points.push(pointAlong(end, runway.headingTrueDeg, CLIMB_OUT_NM * METRES_PER_NM))
  return points.map(([lon, lat], index) => ({
    ident: index === 0 ? `RW${runway.ident}` : '',
    lon,
    lat,
    altitudeFt: 0,
    segment: 'sid' as const,
    runwayPoint: true
  }))
}
