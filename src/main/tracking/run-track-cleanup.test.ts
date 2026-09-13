import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { NewTrackPoint } from '@shared/ipc'
import { createDb, type WingLogDb } from '../db/client'
import { createAircraft } from '../db/aircraft-repo'
import { createFlight } from '../db/flight-repo'
import { createTrackPoint, listTrackPoints } from '../db/track-point-repo'
import { runTrackCleanupForFlight } from './run-track-cleanup'

function samplePoint(flightId: number, overrides: Partial<NewTrackPoint> = {}): NewTrackPoint {
  return {
    flightId,
    tsUtc: '2026-09-01T12:00:00.000Z',
    latitude: 0,
    longitude: 0,
    altitudeM: 10000,
    pressureAltitudeM: null,
    altitudeAglM: 9900,
    indicatedAirspeedMs: 200,
    machSpeed: 0.6,
    groundSpeedMs: 200,
    verticalSpeedMs: 0,
    headingTrueDeg: 90,
    pitchDeg: 2,
    bankDeg: 0,
    phase: 'cruise',
    onGround: false,
    fuelKg: 8000,
    gForce: 1,
    windSpeedMs: 0,
    windDirectionDeg: 0,
    resumeSegment: 0,
    simRate: 1,
    excludedReason: null,
    ...overrides
  }
}

describe('runTrackCleanupForFlight', () => {
  let db: WingLogDb
  let flightId: number

  beforeEach(() => {
    const created = createDb(':memory:')
    migrate(created.db, { migrationsFolder: 'drizzle' })
    db = created.db
    const aircraftId = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' }).id
    flightId = createFlight(db, { aircraftId, depIcao: 'EGLL', arrIcao: 'VHHH' }).id
  })

  it('returns undefined and writes nothing for a flight with no junk', () => {
    createTrackPoint(db, samplePoint(flightId, { tsUtc: '2026-09-01T12:00:00.000Z', latitude: 0, longitude: 0 }))
    createTrackPoint(db, samplePoint(flightId, { tsUtc: '2026-09-01T12:00:05.000Z', latitude: 0.01, longitude: 0 }))
    expect(runTrackCleanupForFlight(db, flightId)).toBeUndefined()
  })

  it('finds and persists a standalone mid-flight teleport on a flight with no active recorder', () => {
    // Stands in for a flight completed before Phase 2 existed, or one where the live
    // per-tick check missed a jump for some reason — the manual Logbook button's use case.
    createTrackPoint(db, samplePoint(flightId, { tsUtc: '2026-09-01T12:00:00.000Z', latitude: 0, longitude: 0 }))
    createTrackPoint(db, samplePoint(flightId, { tsUtc: '2026-09-01T12:00:05.000Z', latitude: 20, longitude: 20 }))
    createTrackPoint(
      db,
      samplePoint(flightId, { tsUtc: '2026-09-01T12:00:10.000Z', latitude: 20.001, longitude: 20.001 })
    )

    const result = runTrackCleanupForFlight(db, flightId)
    expect(result).toBeDefined()
    expect(result?.exclusions).toEqual([])
    expect(result?.segmentReassignments.length).toBe(2)

    const points = listTrackPoints(db, flightId)
    expect(points.every((p) => p.excludedReason === null)).toBe(true)
    const teleportedSegment = points.find((p) => p.latitude === 20)?.resumeSegment
    expect(teleportedSegment).not.toBe(0)
    expect(points.find((p) => p.latitude === 20.001)?.resumeSegment).toBe(teleportedSegment)
    expect(points.find((p) => p.latitude === 0)?.resumeSegment).toBe(0)
  })
})
