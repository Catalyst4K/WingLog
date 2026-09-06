import { asc, eq } from 'drizzle-orm'
import type { NewTrackPoint, TrackPoint } from '@shared/ipc'
import { trackPoint } from './schema'
import type { FlightdeckDb } from './client'

function toTrackPoint(row: typeof trackPoint.$inferSelect): TrackPoint {
  return {
    id: row.id,
    flightId: row.flightId,
    tsUtc: row.tsUtc,
    latitude: row.latitude,
    longitude: row.longitude,
    altitudeM: row.altitudeM,
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
    windDirectionDeg: row.windDirectionDeg
  }
}

export function createTrackPoint(db: FlightdeckDb, input: NewTrackPoint): TrackPoint {
  const [row] = db.insert(trackPoint).values(input).returning().all()
  return toTrackPoint(row)
}

export function listTrackPoints(db: FlightdeckDb, flightId: number): TrackPoint[] {
  return db
    .select()
    .from(trackPoint)
    .where(eq(trackPoint.flightId, flightId))
    .orderBy(asc(trackPoint.id))
    .all()
    .map(toTrackPoint)
}
