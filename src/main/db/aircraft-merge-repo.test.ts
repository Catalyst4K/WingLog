import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { beforeEach, describe, expect, it } from 'vitest'
import { createAircraft, replaceAircraft } from './aircraft-repo'
import { getAircraftRegistrationByUuid, mergeEmptyAircraft } from './aircraft-merge-repo'
import { createDb, type WingLogDb } from './client'
import { createFlight, deleteFlight } from './flight-repo'
import { aircraft, flight } from './schema'
import { getSetting, setSetting } from './settings-repo'

describe('mergeEmptyAircraft', () => {
  let db: WingLogDb

  beforeEach(() => {
    const created = createDb(':memory:')
    migrate(created.db, { migrationsFolder: 'drizzle' })
    db = created.db
  })

  const plane = (registration: string): { id: number; uuid: string } => {
    const created = createAircraft(db, { registration, icaoType: 'B77W' })
    return {
      id: created.id,
      uuid: db.select().from(aircraft).where(eq(aircraft.id, created.id)).get()?.uuid as string
    }
  }

  it('folds an empty copy into the aircraft it is a copy of, and leaves an alias for both names it was known by', () => {
    const real = plane('B-KQH')
    const copy = plane('B-HNR')

    const merged = mergeEmptyAircraft(db, copy.id, real.id, 'the-other-devices-uuid')

    expect(merged).toBe(true)
    expect(
      db
        .select()
        .from(aircraft)
        .all()
        .map((a) => a.registration)
    ).toEqual(['B-KQH'])
    expect(getSetting(db, `aircraftAlias:${copy.uuid}`)).toBe(real.uuid)
    expect(getSetting(db, 'aircraftAlias:the-other-devices-uuid')).toBe(real.uuid)
  })

  it('moves a deleted flight that still pointed at the copy, so the delete does not break its reference', () => {
    const real = plane('B-KQH')
    const copy = plane('B-HNR')
    const gone = createFlight(db, { aircraftId: copy.id, depIcao: 'EGLL', arrIcao: 'VHHH' })
    deleteFlight(db, gone.id)

    expect(mergeEmptyAircraft(db, copy.id, real.id)).toBe(true)

    expect(db.select().from(flight).where(eq(flight.id, gone.id)).get()?.aircraftId).toBe(real.id)
  })

  it('repoints an older alias that stood for the copy, and only an alias', () => {
    const real = plane('B-KQH')
    const copy = plane('B-HNR')
    setSetting(db, 'aircraftAlias:older-uuid', copy.uuid)
    setSetting(db, 'somethingElse', copy.uuid)

    mergeEmptyAircraft(db, copy.id, real.id)

    expect(getSetting(db, 'aircraftAlias:older-uuid')).toBe(real.uuid)
    expect(getSetting(db, 'somethingElse')).toBe(copy.uuid)
  })

  it('leaves an aircraft with a flight of its own alone', () => {
    const real = plane('B-KQH')
    const other = plane('G-ABCD')
    createFlight(db, { aircraftId: other.id, depIcao: 'EGLL', arrIcao: 'EGCC' })

    expect(mergeEmptyAircraft(db, other.id, real.id)).toBe(false)

    expect(db.select().from(aircraft).all()).toHaveLength(2)
  })

  it('leaves an aircraft that was replaced, or that replaced another, alone', () => {
    const a = plane('G-AAAA')
    const b = plane('G-BBBB')
    const c = plane('G-CCCC')
    replaceAircraft(db, { retiredId: a.id, replacementId: b.id })

    expect(mergeEmptyAircraft(db, a.id, c.id)).toBe(false) // a was replaced
    expect(mergeEmptyAircraft(db, b.id, c.id)).toBe(false) // b replaced a (and now has its flights, if any)
    expect(db.select().from(aircraft).all()).toHaveLength(3)
  })

  it('does nothing for the same aircraft, a missing one, or one already deleted', () => {
    const real = plane('B-KQH')
    const copy = plane('B-HNR')
    db.update(aircraft).set({ deletedAt: '2026-11-01T00:00:00.000Z' }).where(eq(aircraft.id, copy.id)).run()

    expect(mergeEmptyAircraft(db, real.id, real.id)).toBe(false)
    expect(mergeEmptyAircraft(db, 9999, real.id)).toBe(false)
    expect(mergeEmptyAircraft(db, copy.id, real.id)).toBe(false)
    expect(mergeEmptyAircraft(db, real.id, copy.id)).toBe(false)
  })

  it('gives an aircraft’s registration from its uuid, and nothing for an unknown uuid', () => {
    const real = plane('B-KQH')

    expect(getAircraftRegistrationByUuid(db, real.uuid)).toBe('B-KQH')
    expect(getAircraftRegistrationByUuid(db, 'no-such-uuid')).toBeUndefined()
  })

  it('does nothing for an aircraft without a uuid yet', () => {
    const real = plane('B-KQH')
    const copy = plane('B-HNR')
    db.update(aircraft).set({ uuid: null }).where(eq(aircraft.id, copy.id)).run()

    expect(mergeEmptyAircraft(db, copy.id, real.id)).toBe(false)
  })
})
