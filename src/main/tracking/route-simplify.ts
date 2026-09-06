/**
 * Derives the lightweight "flown route" polyline stored in flight.flownRouteJson
 * (flightdeck-backend/docs/plans/cloud-sync.md, "The flown route, not the full track") —
 * promoted from scripts/spike-route-simplify.ts, which confirmed against a real flight
 * (VHHH -> WSSS, 1057 track_point rows, 2026-09-04) that 100m tolerance gives the same
 * visual fidelity as 50m at ~1.5x fewer points, and that Callum found no visible
 * difference from the raw trail at either. The full-resolution track_point table this
 * reads from never itself syncs — only this derived output does.
 */
import type { TrackPoint } from '@shared/ipc'

export interface LatLon {
  latitude: number
  longitude: number
}

/** Meters stored, not synced elsewhere — matches this app's SI-internally convention. */
export const FLOWN_ROUTE_TOLERANCE_METERS = 100

const METERS_PER_DEG_LAT = 111_320

/** Local equirectangular projection, re-referenced per segment so longitude compression
 *  (which varies with latitude) doesn't distort distance checks over a route that spans
 *  many degrees of latitude — VHHH (~22°N) to WSSS (~1°N) is a good real example of why
 *  a single global reference latitude isn't good enough here. */
function project(point: LatLon, refLatDeg: number): { x: number; y: number } {
  const metersPerDegLon = METERS_PER_DEG_LAT * Math.cos((refLatDeg * Math.PI) / 180)
  return { x: point.longitude * metersPerDegLon, y: point.latitude * METERS_PER_DEG_LAT }
}

function perpendicularDistanceMeters(point: LatLon, lineStart: LatLon, lineEnd: LatLon): number {
  const refLat = (lineStart.latitude + lineEnd.latitude) / 2
  const p = project(point, refLat)
  const a = project(lineStart, refLat)
  const b = project(lineEnd, refLat)
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  const cross = dx * (p.y - a.y) - dy * (p.x - a.x)
  return Math.abs(cross) / Math.sqrt(lenSq)
}

/** Ramer-Douglas-Peucker. Keeps any point that deviates more than toleranceMeters from
 *  the straight line between its neighbours' kept points — collapses straight cruise
 *  segments, preserves turns/holds/vectoring/go-arounds (the actual point of syncing a
 *  flown route instead of just replaying the planned one). */
export function simplifyRoute<T extends LatLon>(points: T[], toleranceMeters: number): T[] {
  if (points.length < 3) return points.slice()

  function rdp(pts: T[]): T[] {
    if (pts.length < 3) return pts
    let maxDist = 0
    let index = 0
    const start = pts[0]
    const end = pts[pts.length - 1]
    for (let i = 1; i < pts.length - 1; i++) {
      const d = perpendicularDistanceMeters(pts[i], start, end)
      if (d > maxDist) {
        maxDist = d
        index = i
      }
    }
    if (maxDist > toleranceMeters) {
      const left = rdp(pts.slice(0, index + 1))
      const right = rdp(pts.slice(index))
      return left.slice(0, -1).concat(right)
    }
    return [start, end]
  }

  return rdp(points)
}

/** JSON-encoded [{latitude, longitude}, ...] — same shape as ofpJson's own storage
 *  pattern (a JSON text column, parsed client-side for display). Null for fewer than 2
 *  points (nothing to draw a line through), rather than storing an empty/single-point
 *  array a map layer would have to special-case. */
export function deriveFlownRouteJson(points: TrackPoint[]): string | null {
  if (points.length < 2) return null
  const latLons: LatLon[] = points.map((p) => ({ latitude: p.latitude, longitude: p.longitude }))
  const simplified = simplifyRoute(latLons, FLOWN_ROUTE_TOLERANCE_METERS)
  return JSON.stringify(simplified)
}
