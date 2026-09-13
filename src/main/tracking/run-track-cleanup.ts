import type { WingLogDb } from '../db/client'
import { applyTrackCleanup, listTrackPoints } from '../db/track-point-repo'
import { computeTrackCleanup, type TrackCleanupResult } from './resume-cleanup'

/**
 * Runs resume-cleanup.ts's pure function over one flight's full current `track_point`
 * history and persists whatever it finds. Depends on nothing but the DB, so it works
 * equally for a flight actively being tracked (TrackingController.runTrackCleanup wraps
 * this and also emits 'pointsUpdated' for the live map) and a flight completed long ago
 * (the Logbook "Clean up track" button, main/index.ts — flightdeck-backend's docs/plans/
 * done/resume-track-cleanup.md). Returns undefined when nothing changed; `applyTrackCleanup`
 * itself already no-ops a write for an empty result, so a no-op call here is cheap.
 */
export function runTrackCleanupForFlight(db: WingLogDb, flightId: number): TrackCleanupResult | undefined {
  const points = listTrackPoints(db, flightId)
  const result = computeTrackCleanup(points)
  if (result.exclusions.length === 0 && result.segmentReassignments.length === 0) return undefined
  applyTrackCleanup(db, result)
  return result
}
