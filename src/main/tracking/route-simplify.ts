/**
 * Derives the lightweight "flown route" polyline stored in flight.flownRouteJson
 * (winglog-backend/docs/plans/cloud-sync.md, "The flown route, not the full track") —
 * promoted from scripts/spike-route-simplify.ts, which confirmed against a real flight
 * (VHHH -> WSSS, 1057 track_point rows, 2026-09-04) that 100m tolerance gives the same
 * visual fidelity as 50m at ~1.5x fewer points, and that Callum found no visible
 * difference from the raw trail at either. The full-resolution track_point table this
 * reads from never itself syncs — only this derived output does.
 */
import type { TrackPoint } from '@shared/ipc'
import { pointToLineM } from '@shared/geo'
import { simplifyIndices } from './douglas-peucker'

export interface LatLon {
  latitude: number
  longitude: number
}

/** Meters stored, not synced elsewhere — matches this app's SI-internally convention. */
export const FLOWN_ROUTE_TOLERANCE_METERS = 100

/** Ramer-Douglas-Peucker. Keeps any point that deviates more than toleranceMeters from
 *  the straight line between its neighbours' kept points — collapses straight cruise
 *  segments, preserves turns/holds/vectoring/go-arounds (the actual point of syncing a
 *  flown route instead of just replaying the planned one).
 *
 * @param points The route, in order.
 * @param toleranceMeters How far a point may be off the simplified line, metres.
 * @returns The points kept, in order (always the first and last).
 */
export function simplifyRoute<T extends LatLon>(points: T[], toleranceMeters: number): T[] {
  const keep = simplifyIndices(points, toleranceMeters, (p, a, b) =>
    pointToLineM(toLatLon(p), toLatLon(a), toLatLon(b))
  )
  return [...keep].sort((x, y) => x - y).map((i) => points[i])
}

function toLatLon(p: LatLon): { lat: number; lon: number } {
  return { lat: p.latitude, lon: p.longitude }
}

/** JSON-encoded [{latitude, longitude}, ...] — same shape as ofpJson's own storage
 *  pattern (a JSON text column, parsed client-side for display). Null for fewer than 2
 *  points (nothing to draw a line through), rather than storing an empty/single-point
 *  array a map layer would have to special-case.
 *
 * @param points A flight's track, in order.
 * @returns The JSON text, or null.
 */
export function deriveFlownRouteJson(points: TrackPoint[]): string | null {
  if (points.length < 2) return null
  const latLons: LatLon[] = points.map((p) => ({ latitude: p.latitude, longitude: p.longitude }))
  const simplified = simplifyRoute(latLons, FLOWN_ROUTE_TOLERANCE_METERS)
  return JSON.stringify(simplified)
}
