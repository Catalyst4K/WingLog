import type { TrackPoint } from '@shared/ipc'
import { perpendicularDistance2D, simplifyIndices, type Point2D } from './douglas-peucker'

// Route tolerance matches scripts/spike-route-simplify.ts's confirmed value (run against a
// real recorded flight, VHHH -> WSSS, docs/decisions.md 2026-09-04) — 100m kept the route's
// shape and turns indistinguishable from 50m at ~1.5x fewer points. That spike was built
// for a different feature (cloud-sync's flownRouteJson payload size), but the technique and
// tolerance apply equally well here, for the same reason: a straight cruise leg doesn't need
// every 1Hz sample to look like a straight line on a map.
const ROUTE_TOLERANCE_M = 100
// Altitude/speed tolerances are generous enough to erase 1Hz sensor noise and cruise-level
// steadiness, tight enough that a real step climb or a speed change during descent survives
// — these feed the Logbook's altitude/IAS charts, not a safety-critical measurement.
const ALTITUDE_TOLERANCE_M = 15 // ~50 ft
const SPEED_TOLERANCE_MS = 3 // ~6 kt

const METERS_PER_DEG_LAT = 111_320

interface LatLon {
  latitude: number
  longitude: number
}

/** Local equirectangular projection, re-referenced per segment (using the segment's own
 *  midpoint latitude) so longitude compression — which varies with latitude — doesn't
 *  distort the distance check over a route spanning many degrees of latitude (VHHH ~22°N
 *  to WSSS ~1°N is the real case that motivated this in the original spike). */
function project(point: LatLon, refLatDeg: number): Point2D {
  const metersPerDegLon = METERS_PER_DEG_LAT * Math.cos((refLatDeg * Math.PI) / 180)
  return { x: point.longitude * metersPerDegLon, y: point.latitude * METERS_PER_DEG_LAT }
}

function latLonDistanceMeters(point: LatLon, lineStart: LatLon, lineEnd: LatLon): number {
  const refLat = (lineStart.latitude + lineEnd.latitude) / 2
  return perpendicularDistance2D(project(point, refLat), project(lineStart, refLat), project(lineEnd, refLat))
}

/**
 * Reduces a flight's full-resolution track_point rows down to the points that actually
 * matter for display — the ones a straight line (in position, altitude, or speed) between
 * their neighbours wouldn't already predict. Storage keeps every row at full resolution
 * regardless (nothing about this touches the database); this only shapes what a caller
 * hands to the map/charts, cutting both the IPC payload and everything downstream that
 * has to hold, diff, or render it. A long-haul's cruise leg — thousands of nearly-
 * identical samples — is exactly the case this collapses hardest; turns, climbs,
 * descents, and speed changes survive because that's precisely where each pass finds a
 * real deviation from a straight line.
 *
 * Three independent Douglas-Peucker passes (route shape, altitude profile, speed
 * profile), unioned rather than run once — a flight-level step climb over an otherwise
 * arrow-straight cruise leg has essentially zero lat/lon deviation, so a route-only pass
 * would erase it from the altitude chart even though the map wouldn't miss it.
 */
export function simplifyTrackPoints(points: TrackPoint[]): TrackPoint[] {
  if (points.length <= 2) return points

  const t0 = new Date(points[0].tsUtc).getTime()
  const secondsSinceStart = points.map((p) => (new Date(p.tsUtc).getTime() - t0) / 1000)
  const altitudePoints: Point2D[] = points.map((p, i) => ({ x: secondsSinceStart[i], y: p.altitudeM }))
  const speedPoints: Point2D[] = points.map((p, i) => ({ x: secondsSinceStart[i], y: p.indicatedAirspeedMs }))

  const keepRoute = simplifyIndices(points, ROUTE_TOLERANCE_M, latLonDistanceMeters)
  const keepAltitude = simplifyIndices(altitudePoints, ALTITUDE_TOLERANCE_M, perpendicularDistance2D)
  const keepSpeed = simplifyIndices(speedPoints, SPEED_TOLERANCE_MS, perpendicularDistance2D)

  const keep = new Set<number>([...keepRoute, ...keepAltitude, ...keepSpeed])
  return points.filter((_, i) => keep.has(i))
}
