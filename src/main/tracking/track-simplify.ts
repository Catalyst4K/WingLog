/**
 * Thins a flight's recorded track for display (the Track map, the Logbook map and charts): three
 * Douglas-Peucker passes over position, altitude and speed, plus a finer pass for each stretch on
 * the ground. Storage keeps every point; this only shapes what's drawn.
 */
import type { TrackPoint } from '@shared/ipc'
import { pointToLineM, pointToSegmentM } from '@shared/geo'
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
// 2026-10-05, winglog-backend's ground-track-resolution.md). Each on-ground run gets its
// own pass at 5m instead, which cost only +5 to +25 points per flight on that same data.
const GROUND_ROUTE_TOLERANCE_M = 5
// Altitude/speed tolerances are generous enough to erase 1Hz sensor noise and cruise-level
// steadiness, tight enough that a real step climb or a speed change during descent survives
// — these feed the Logbook's altitude/IAS charts, not a safety-critical measurement.
const ALTITUDE_TOLERANCE_M = 15 // ~50 ft
const SPEED_TOLERANCE_MS = 3 // ~6 kt

interface LatLon {
  latitude: number
  longitude: number
}

function toLatLon(p: LatLon): { lat: number; lon: number } {
  return { lat: p.latitude, lon: p.longitude }
}

/** Distance from a point to the line through two others, re-projected per line so it holds over
 *  routes spanning many degrees of latitude (VHHH ~22°N to WSSS ~1°N).
 *
 * @param point The point measured.
 * @param lineStart One point on the line.
 * @param lineEnd Another point on the line.
 * @returns Metres.
 */
function latLonDistanceMeters(point: LatLon, lineStart: LatLon, lineEnd: LatLon): number {
  return pointToLineM(toLatLon(point), toLatLon(lineStart), toLatLon(lineEnd))
}

/** Like latLonDistanceMeters, but to the segment rather than the infinite line through it.
 *  On the ground the aircraft reverses along its own path (pushback, then taxi forward over
 *  the same line), and a line distance scores that turn-around point as 0m off, so the
 *  simplified track cut it off (flight 225: worst ground cut 15m with line distance, 6m with
 *  this). In the air the track doesn't double back like that, so the air pass keeps the
 *  line distance it has always used.
 *
 * @param point The point measured.
 * @param segStart The segment's start.
 * @param segEnd The segment's end.
 * @returns Metres.
 */
function latLonSegmentDistanceMeters(point: LatLon, segStart: LatLon, segEnd: LatLon): number {
  return pointToSegmentM(toLatLon(point), toLatLon(segStart), toLatLon(segEnd))
}

/** Indices to keep from each contiguous on-ground run, simplified at the ground tolerance.
 *  Each run's first and last point are always kept, so the air/ground join stays exactly
 *  where it was recorded.
 *
 * @param points A flight's track, in order.
 * @returns Indices into `points`, run by run.
 */
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
 *
 * @param points A flight's track, in order.
 * @returns The points kept, in order.
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
