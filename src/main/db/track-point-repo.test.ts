import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { NewTrackPoint } from '@shared/ipc'
import { createDb, type WingLogDb } from './client'
import { createAircraft } from './aircraft-repo'
import { createFlight } from './flight-repo'
import { applyTrackCleanup, createTrackPoint, listTrackPoints } from './track-point-repo'

function samplePoint(flightId: number, overrides: Partial<NewTrackPoint> = {}): NewTrackPoint {
  return {
    flightId,
    tsUtc: '2026-09-01T12:00:00.000Z',
    latitude: 51.4775,
    longitude: -0.4614,
    altitudeM: 100,
    pressureAltitudeM: null,
    altitudeAglM: 100,
    indicatedAirspeedMs: 50,
    machSpeed: 0,
    groundSpeedMs: 50,
    verticalSpeedMs: 0,
    headingTrueDeg: 270,
    pitchDeg: 0,
    bankDeg: 0,
    phase: 'cruise',
    onGround: false,
    fuelKg: 5000,
    gForce: 1,
    windSpeedMs: 0,
    windDirectionDeg: 0,
    resumeSegment: 0,
    simRate: 1,
    excludedReason: null,
    ...overrides
  }
}

describe('track point repo', () => {
  let db: WingLogDb
  let flightId: number

  beforeEach(() => {
    const created = createDb(':memory:')
    migrate(created.db, { migrationsFolder: 'drizzle' })
    db = created.db
    const aircraftId = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' }).id
    flightId = createFlight(db, { aircraftId, depIcao: 'EGLL', arrIcao: 'VHHH' }).id
  })

  it('starts empty for a flight with no points', () => {
    expect(listTrackPoints(db, flightId)).toEqual([])
  })

  it('creates and lists points in insertion order', () => {
    const first = createTrackPoint(db, samplePoint(flightId, { tsUtc: '2026-09-01T12:00:00.000Z' }))
    const second = createTrackPoint(db, samplePoint(flightId, { tsUtc: '2026-09-01T12:00:15.000Z' }))
    expect(listTrackPoints(db, flightId)).toEqual([first, second])
  })

  it('rejects a point for a nonexistent flight', () => {
    expect(() => createTrackPoint(db, samplePoint(99999))).toThrow()
  })

  it('round-trips pressureAltitudeM, and leaves it null when never supplied (an older row)', () => {
    const withPressure = createTrackPoint(db, samplePoint(flightId, { pressureAltitudeM: 1234.5 }))
    const withoutPressure = createTrackPoint(
      db,
      samplePoint(flightId, { tsUtc: '2026-09-01T12:00:15.000Z', pressureAltitudeM: null })
    )
    expect(listTrackPoints(db, flightId)).toEqual([withPressure, withoutPressure])
    expect(withPressure.pressureAltitudeM).toBe(1234.5)
    expect(withoutPressure.pressureAltitudeM).toBeNull()
  })

  it('only returns points for the requested flight', () => {
    const aircraftId = createAircraft(db, { registration: 'G-EFGH', icaoType: 'B738' }).id
    const otherFlightId = createFlight(db, { aircraftId, depIcao: 'KJFK', arrIcao: 'KLAX' }).id
    createTrackPoint(db, samplePoint(flightId))
    createTrackPoint(db, samplePoint(otherFlightId))
    expect(listTrackPoints(db, flightId)).toHaveLength(1)
    expect(listTrackPoints(db, otherFlightId)).toHaveLength(1)
  })

  describe('applyTrackCleanup', () => {
    it('does nothing for an empty result', () => {
      const point = createTrackPoint(db, samplePoint(flightId))
      applyTrackCleanup(db, { exclusions: [], segmentReassignments: [] })
      expect(listTrackPoints(db, flightId)).toEqual([point])
    })

    it('marks excluded points with their reason, leaving others untouched', () => {
      const junk = createTrackPoint(db, samplePoint(flightId))
      const clean = createTrackPoint(db, samplePoint(flightId, { tsUtc: '2026-09-01T12:00:15.000Z' }))
      applyTrackCleanup(db, {
        exclusions: [{ id: junk.id, reason: 'resume-spurious' }],
        segmentReassignments: []
      })
      const points = listTrackPoints(db, flightId)
      expect(points.find((p) => p.id === junk.id)?.excludedReason).toBe('resume-spurious')
      expect(points.find((p) => p.id === clean.id)?.excludedReason).toBe(null)
    })

    it('retags points with a new resumeSegment', () => {
      const before = createTrackPoint(db, samplePoint(flightId))
      const after = createTrackPoint(db, samplePoint(flightId, { tsUtc: '2026-09-01T12:00:15.000Z' }))
      applyTrackCleanup(db, { exclusions: [], segmentReassignments: [{ id: after.id, resumeSegment: 7 }] })
      const points = listTrackPoints(db, flightId)
      expect(points.find((p) => p.id === before.id)?.resumeSegment).toBe(0)
      expect(points.find((p) => p.id === after.id)?.resumeSegment).toBe(7)
    })
  })
})
