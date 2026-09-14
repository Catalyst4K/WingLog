import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import { createDb, type WingLogDb } from './client'
import { createAircraft } from './aircraft-repo'
import { createFlight } from './flight-repo'
import { flight, landing } from './schema'
import type { NewLanding } from './landing-repo'
import {
  createLanding,
  getLandingByFlight,
  listLandingsByAircraft,
  listLandingsForSync,
  upsertLandingByUuid
} from './landing-repo'

function makeLanding(flightId: number, overrides: Partial<NewLanding> = {}): NewLanding {
  return {
    flightId,
    touchdownTsUtc: '2026-09-06T12:00:00.000Z',
    verticalSpeedMs: -1.2,
    gForce: 1.3,
    pitchDeg: 2,
    bankDeg: 0.5,
    headingTrueDeg: 270,
    indicatedAirspeedMs: 70,
    groundSpeedMs: 68,
    windSpeedMs: 5,
    windDirectionDeg: 260,
    headwindMs: 4,
    crosswindMs: 1,
    crabDeg: 2,
    runwayIdent: '27L',
    distanceFromThresholdM: 120,
    centrelineOffsetM: 1.5,
    flapSetting: 3,
    touchdownSource: 'derived',
    ...overrides
  }
}

describe('landing repo', () => {
  let db: WingLogDb
  let aircraftId: number
  let flightId: number

  beforeEach(() => {
    const created = createDb(':memory:')
    migrate(created.db, { migrationsFolder: 'drizzle' })
    db = created.db
    aircraftId = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' }).id
    flightId = createFlight(db, { aircraftId, depIcao: 'EGLL', arrIcao: 'EGCC' }).id
  })

  it('returns undefined when a flight has no landing', () => {
    expect(getLandingByFlight(db, flightId)).toBeUndefined()
  })

  it('creates a landing and reads it back', () => {
    const created = createLanding(db, makeLanding(flightId))
    expect(created.id).toBeTypeOf('number')
    expect(getLandingByFlight(db, flightId)).toEqual(created)
  })

  it('excludes a soft-deleted landing from getLandingByFlight', () => {
    const created = createLanding(db, makeLanding(flightId))
    db.update(landing).set({ deletedAt: new Date().toISOString() }).where(eq(landing.id, created.id)).run()
    expect(getLandingByFlight(db, flightId)).toBeUndefined()
  })

  it('replaces the existing landing on a re-capture rather than duplicating it', () => {
    const first = createLanding(db, makeLanding(flightId, { verticalSpeedMs: -1.0 }))
    const second = createLanding(db, makeLanding(flightId, { verticalSpeedMs: -3.5 }))

    expect(second.id).toBe(first.id)
    expect(getLandingByFlight(db, flightId)?.verticalSpeedMs).toBe(-3.5)
    const rows = db.select().from(landing).all()
    expect(rows).toHaveLength(1)
  })

  it('keeps the original uuid across a re-capture', () => {
    createLanding(db, makeLanding(flightId))
    const originalUuid = db.select().from(landing).where(eq(landing.flightId, flightId)).get()?.uuid
    createLanding(db, makeLanding(flightId, { verticalSpeedMs: -2 }))
    const afterUuid = db.select().from(landing).where(eq(landing.flightId, flightId)).get()?.uuid

    expect(originalUuid).not.toBeNull()
    expect(afterUuid).toBe(originalUuid)
  })

  describe('listLandingsByAircraft', () => {
    it('returns an empty array for an aircraft with no landings', () => {
      expect(listLandingsByAircraft(db, aircraftId)).toEqual([])
    })

    it('lists landings newest-first, joined with flight route info', () => {
      const olderFlight = createFlight(db, { aircraftId, depIcao: 'EGCC', arrIcao: 'EGLL', flightNumber: 'BA100' })
      createLanding(db, makeLanding(olderFlight.id, { touchdownTsUtc: '2026-09-01T00:00:00.000Z' }))
      createLanding(db, makeLanding(flightId, { touchdownTsUtc: '2026-09-06T12:00:00.000Z' }))

      const rows = listLandingsByAircraft(db, aircraftId)
      expect(rows).toHaveLength(2)
      expect(rows[0].touchdownTsUtc).toBe('2026-09-06T12:00:00.000Z')
      expect(rows[0].depIcao).toBe('EGLL')
      expect(rows[1].flightNumber).toBe('BA100')
    })

    it('excludes landings whose flight is soft-deleted', () => {
      createLanding(db, makeLanding(flightId))
      db.update(flight).set({ deletedAt: new Date().toISOString() }).where(eq(flight.id, flightId)).run()
      expect(listLandingsByAircraft(db, aircraftId)).toEqual([])
    })
  })

  describe('listLandingsForSync', () => {
    it('returns every synced-eligible landing when since is null', () => {
      createLanding(db, makeLanding(flightId))
      const rows = listLandingsForSync(db, null)
      expect(rows).toHaveLength(1)
    })

    it('excludes landings updated at or before since', () => {
      createLanding(db, makeLanding(flightId))
      const cutoff = db.select().from(landing).get()!.updatedAt as string
      const flight2 = createFlight(db, { aircraftId, depIcao: 'EGCC', arrIcao: 'EGLL' })
      createLanding(db, makeLanding(flight2.id))
      const rows = listLandingsForSync(db, cutoff)
      expect(rows).toHaveLength(1)
      expect(rows[0].flightId).toBe(flight2.id)
    })
  })

  describe('upsertLandingByUuid', () => {
    it('inserts a new landing when no uuid match exists', () => {
      const applied = upsertLandingByUuid(db, {
        uuid: 'remote-uuid-1',
        flightId,
        touchdownTsUtc: '2026-09-06T12:00:00.000Z',
        verticalSpeedMs: -1,
        gForce: 1.1,
        pitchDeg: 1,
        bankDeg: 0,
        headingTrueDeg: 90,
        indicatedAirspeedMs: 65,
        groundSpeedMs: 63,
        windSpeedMs: 3,
        windDirectionDeg: 90,
        touchdownSource: 'derived',
        updatedAt: '2026-09-06T12:00:00.000Z'
      })
      expect(applied).toBe(true)
      expect(getLandingByFlight(db, flightId)).toBeTruthy()
    })

    it('updates an existing landing by uuid when the incoming version is newer', () => {
      createLanding(db, makeLanding(flightId))
      const existing = db.select().from(landing).where(eq(landing.flightId, flightId)).get()!

      const applied = upsertLandingByUuid(db, {
        ...existing,
        uuid: existing.uuid as string,
        verticalSpeedMs: -9,
        updatedAt: '2099-01-01T00:00:00.000Z'
      })

      expect(applied).toBe(true)
      expect(getLandingByFlight(db, flightId)?.verticalSpeedMs).toBe(-9)
    })

    it('refuses to apply an incoming row that is not newer than the local one', () => {
      createLanding(db, makeLanding(flightId))
      const existing = db.select().from(landing).where(eq(landing.flightId, flightId)).get()!

      const applied = upsertLandingByUuid(db, {
        ...existing,
        uuid: existing.uuid as string,
        verticalSpeedMs: -9,
        updatedAt: '2000-01-01T00:00:00.000Z'
      })

      expect(applied).toBe(false)
      expect(getLandingByFlight(db, flightId)?.verticalSpeedMs).not.toBe(-9)
    })
  })
})
