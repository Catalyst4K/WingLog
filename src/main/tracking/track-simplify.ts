import type { TrackPoint } from '@shared/ipc'
import { perpendicularDistance2D, simplifyIndices, type Point2D } from './douglas-peucker'

// Route tolerance matches scripts/spike-route-simplify.ts's confirmed value (run against a
// real recorded flight, VHHH -> WSSS, docs/decisions.md 2026-09-04) — 100m kept the route's
// shape and turns indistinguishable from 50m at ~1.5x fewer points. That spike was built
// for a different feature (cloud-sync's flownRouteJson payload size), but the technique and
// tolerance apply equally well here, for the same reason: a straight cruise leg doesn't need
// every 1Hz sample to look like a straight line on a map.
const ROUTE_TOLERANCE_M = 100
// On the ground 100m is the wrong scale: a taxiway is ~23m wide and parallel taxiways are
// often 100-200m apart, so a whole flight's taxiing collapsed to 21-33 points and cut
// corners by up to 54m, straight across the taxi chart (flights 220-227, measured
// 2026-10-05, flightdeck-backend's ground-track-resolution.md). Each on-ground run gets its
// own pass at 5m instead, which cost only +5 to +25 points per flight on that same data.
const GROUND_ROUTE_TOLERANCE_M = 5
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

/** Like latLonDistanceMeters, but to the segment rather than the infinite line through it.
 *  On the ground the aircraft reverses along its own path (pushback, then taxi forward over
 *  the same line), and a line distance scores that turn-around point as 0m off, so the
 *  simplified track cut it off (flight 225: worst ground cut 15m with line distance, 6m with
 *  this). In the air the track doesn't double back like that, so the air pass keeps the
 *  line distance it has always used. */
function latLonSegmentDistanceMeters(point: LatLon, segStart: LatLon, segEnd: LatLon): number {
  const refLat = (segStart.latitude + segEnd.latitude) / 2
  const p = project(point, refLat)
  const a = project(segStart, refLat)
  const b = project(segEnd, refLat)
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** Indices to keep from each contiguous on-ground run, simplified at the ground tolerance.
 *  Each run's first and last point are always kept, so the air/ground join stays exactly
 *  where it was recorded. */
function groundRouteIndices(points: TrackPoint[]): number[] {
  const indices: number[] = []
  let runStart = -1
  for (let i = 0; i <= points.length; i++) {
    const onGround = i < points.length && points[i].onGround
    if (onGround && runStart === -1) runStart = i
    if (!onGround && runStart !== -1) {
      const run = points.slice(runStart, i)
      for (const index of simplifyIndices(run, GROUND_ROUTE_TOLERANCE_M, latLonSegmentDistanceMeters)) {
        indices.push(runStart + index)
      }
      runStart = -1
    }
  }
  return indices
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
  for (const index of groundRouteIndices(points)) keepRoute.add(index)
  const keepAltitude = simplifyIndices(altitudePoints, ALTITUDE_TOLERANCE_M, perpendicularDistance2D)
  const keepSpeed = simplifyIndices(speedPoints, SPEED_TOLERANCE_MS, perpendicularDistance2D)

  const keep = new Set<number>([...keepRoute, ...keepAltitude, ...keepSpeed])
  return points.filter((_, i) => keep.has(i))
}
