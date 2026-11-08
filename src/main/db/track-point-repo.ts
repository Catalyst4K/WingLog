/**
 * A flight's recorded track points: written once a second while tracking, listed in order for the
 * map, and marked or re-segmented by the resume cleanup. Never synced.
 */
import { and, asc, eq, isNull, notExists, sql } from 'drizzle-orm'
import type { NewTrackPoint, TrackPoint } from '@shared/ipc'
import type { TrackCleanupResult } from '../tracking/resume-cleanup'
import { flight, trackPoint } from './schema'
import type { WingLogDb } from './client'

/**
 * A database row as a TrackPoint.
 *
 * @param row The `track_point` row.
 * @returns The point as the app sees it.
 */
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

/**
 * Records one track point.
 *
 * @param db The database.
 * @param input The point.
 * @returns The stored point.
 */
export function createTrackPoint(db: WingLogDb, input: NewTrackPoint): TrackPoint {
  const [row] = db.insert(trackPoint).values(input).returning().all()
  return toTrackPoint(row)
}

/**
 * A flight's track points.
 *
 * @param db The database.
 * @param flightId The flight.
 * @returns Its points in recording order, excluded ones included.
 */
export function listTrackPoints(db: WingLogDb, flightId: number): TrackPoint[] {
  return db
    .select()
    .from(trackPoint)
    .where(eq(trackPoint.flightId, flightId))
    .orderBy(asc(trackPoint.id))
    .all()
    .map(toTrackPoint)
}

/**
 * A flight's track points exactly as stored, for a twin to copy: every column except the ids, which mean nothing on another computer.
 *
 * @param db The database.
 * @param flightId The flight.
 * @param offset How many points to skip, in recording order.
 * @param limit The most to return.
 * @returns The points' fields.
 */
export function listTrackPointRows(
  db: WingLogDb,
  flightId: number,
  offset: number,
  limit: number
): Record<string, unknown>[] {
  return db
    .select()
    .from(trackPoint)
    .where(eq(trackPoint.flightId, flightId))
    .orderBy(asc(trackPoint.id))
    .limit(limit)
    .offset(offset)
    .all()
    .map((row) => {
      const fields: Record<string, unknown> = { ...row }
      // The ids mean nothing on another computer.
      delete fields.id
      delete fields.flightId
      return fields
    })
}

/**
 * @param db The database.
 * @param flightId The flight.
 * @returns How many track points it has.
 */
export function countTrackPoints(db: WingLogDb, flightId: number): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(trackPoint)
      .where(eq(trackPoint.flightId, flightId))
      .get()?.n ?? 0
  )
}

/**
 * @param db The database.
 * @returns The completed flights that have no track points here yet (their rows came by sync, and their points do not).
 */
export function listCompletedFlightsWithoutTrack(db: WingLogDb): { id: number; uuid: string }[] {
  return db
    .select({ id: flight.id, uuid: flight.uuid })
    .from(flight)
    .where(
      and(
        eq(flight.status, 'completed'),
        isNull(flight.deletedAt),
        notExists(
          db
            .select({ one: sql`1` })
            .from(trackPoint)
            .where(eq(trackPoint.flightId, flight.id))
        )
      )
    )
    .all()
    .flatMap((row) => (row.uuid ? [{ id: row.id, uuid: row.uuid }] : []))
}

/**
 * Stores track points brought from another computer, as one transaction.
 *
 * @param db The database.
 * @param rows The points' fields, already checked, with this computer's flight id.
 */
export function insertTrackPointRows(db: WingLogDb, rows: (typeof trackPoint.$inferInsert)[]): void {
  db.transaction((tx) => {
    for (let i = 0; i < rows.length; i += INSERT_BATCH)
      tx.insert(trackPoint)
        .values(rows.slice(i, i + INSERT_BATCH))
        .run()
  })
}

/** Points per insert statement, under SQLite's limit on variables in one. */
const INSERT_BATCH = 500

/** Persists a resume-cleanup pass's output (winglog-backend's docs/plans/
 *  resume-track-cleanup.md, Phase 2) — marks junk points, and retags points on the far
 *  side of a mid-flight teleport with a new resumeSegment so the map stops joining them
 *  to what came before with a straight line. One transaction so a caller never observes
 *  half the result applied; a no-op write for a result with nothing in either list.
 *
 * @param db The database.
 * @param result The points to exclude and the ones to move to a new segment.
 */
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
