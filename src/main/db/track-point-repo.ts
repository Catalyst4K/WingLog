import { asc, eq } from 'drizzle-orm'
import type { NewTrackPoint, TrackPoint } from '@shared/ipc'
import type { TrackCleanupResult } from '../tracking/resume-cleanup'
import { trackPoint } from './schema'
import type { WingLogDb } from './client'

function toTrackPoint(row: typeof trackPoint.$inferSelect): TrackPoint {
  return {
    id: row.id,
    flightId: row.flightId,
    tsUtc: row.tsUtc,
    latitude: row.latitude,
    longitude: row.longitude,
    altitudeM: row.altitudeM,
    pressureAltitudeM: row.pressureAltitudeM,
    altitudeAglM: row.altitudeAglM,
    indicatedAirspeedMs: row.indicatedAirspeedMs,
    machSpeed: row.machSpeed,
    groundSpeedMs: row.groundSpeedMs,
    verticalSpeedMs: row.verticalSpeedMs,
    headingTrueDeg: row.headingTrueDeg,
    pitchDeg: row.pitchDeg,
    bankDeg: row.bankDeg,
    phase: row.phase,
    onGround: row.onGround,
    fuelKg: row.fuelKg,
    gForce: row.gForce,
    windSpeedMs: row.windSpeedMs,
    windDirectionDeg: row.windDirectionDeg,
    resumeSegment: row.resumeSegment,
    simRate: row.simRate,
    excludedReason: row.excludedReason
  }
}

export function createTrackPoint(db: WingLogDb, input: NewTrackPoint): TrackPoint {
  const [row] = db.insert(trackPoint).values(input).returning().all()
  return toTrackPoint(row)
}

export function listTrackPoints(db: WingLogDb, flightId: number): TrackPoint[] {
  return db
    .select()
    .from(trackPoint)
    .where(eq(trackPoint.flightId, flightId))
    .orderBy(asc(trackPoint.id))
    .all()
    .map(toTrackPoint)
}

/** Persists a resume-cleanup pass's output (flightdeck-backend's docs/plans/
 *  resume-track-cleanup.md, Phase 2) — marks junk points, and retags points on the far
 *  side of a mid-flight teleport with a new resumeSegment so the map stops joining them
 *  to what came before with a straight line. One transaction so a caller never observes
 *  half the result applied; a no-op write for a result with nothing in either list. */
export function applyTrackCleanup(db: WingLogDb, result: TrackCleanupResult): void {
  if (result.exclusions.length === 0 && result.segmentReassignments.length === 0) return
  db.transaction((tx) => {
    for (const { id, reason } of result.exclusions) {
      tx.update(trackPoint).set({ excludedReason: reason }).where(eq(trackPoint.id, id)).run()
    }
    for (const { id, resumeSegment } of result.segmentReassignments) {
      tx.update(trackPoint).set({ resumeSegment }).where(eq(trackPoint.id, id)).run()
    }
  })
}
