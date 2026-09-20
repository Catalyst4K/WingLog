import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import { setMainLanguage } from '../i18n'
import { createDb, type WingLogDb } from './client'
import { aircraft as aircraftTable, flight } from './schema'
import {
  createAircraft,
  deleteAircraft,
  getAircraftByRegistration,
  listAircraft,
  replaceAircraft,
  retireAircraft,
  unretireAircraft,
  updateAircraft
} from './aircraft-repo'
import { createFlight } from './flight-repo'

describe('aircraft repo', () => {
  let db: WingLogDb

  beforeEach(() => {
    const created = createDb(':memory:')
    migrate(created.db, { migrationsFolder: 'drizzle' })
    db = created.db
  })

  afterEach(() => {
    setMainLanguage('en', 'en-US')
  })

  it('starts empty', () => {
    expect(listAircraft(db)).toEqual([])
  })

  it('writes a row and reads it back, with defaults applied', () => {
    const created = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' })

    expect(created.id).toBeTypeOf('number')
    expect(created.operator).toBeNull()
    expect(created.simbriefAirframeId).toBeNull()
    expect(created.currentIcao).toBeNull()
    expect(listAircraft(db)).toEqual([created])
  })

  it('stores the full field set', () => {
    const created = createAircraft(db, {
      registration: 'G-ABCD',
      icaoType: 'A320',
      operator: 'Test Air',
      operatorIcao: 'TST',
      simbriefAirframeId: '123456_1582090020',
      currentIcao: 'EGLL'
    })

    expect(created.operator).toBe('Test Air')
    expect(created.operatorIcao).toBe('TST')
    expect(created.simbriefAirframeId).toBe('123456_1582090020')
    expect(created.currentIcao).toBe('EGLL')
  })

  it('rejects a duplicate registration', () => {
    createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' })
    expect(() => createAircraft(db, { registration: 'G-ABCD', icaoType: 'B738' })).toThrow()
  })

  it('finds an aircraft by registration', () => {
    const created = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' })
    expect(getAircraftByRegistration(db, 'G-ABCD')).toEqual(created)
    expect(getAircraftByRegistration(db, 'G-NOPE')).toBeUndefined()
  })

  it('updates an aircraft', () => {
    const created = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' })
    const updated = updateAircraft(db, {
      id: created.id,
      registration: 'G-ABCD',
      icaoType: 'A320',
      operator: 'Renamed Air'
    })
    expect(updated?.operator).toBe('Renamed Air')
    expect(listAircraft(db)).toEqual([updated])
  })

  it('deletes an aircraft (a tombstone, not a hard delete — still resolvable by id)', () => {
    const created = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' })
    deleteAircraft(db, created.id)
    expect(listAircraft(db)).toEqual([])
    const raw = db.select().from(aircraftTable).where(eq(aircraftTable.id, created.id)).get()
    expect(raw?.deletedAt).not.toBeNull()
  })

  it('refuses to delete an aircraft that still has a non-deleted flight', () => {
    const created = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' })
    createFlight(db, { aircraftId: created.id, depIcao: 'EGLL', arrIcao: 'VHHH' })
    expect(() => deleteAircraft(db, created.id)).toThrow(/flights/)
    expect(listAircraft(db)).toEqual([created])
  })

  describe('replaceAircraft', () => {
    function makeAircraftPair(): { retired: ReturnType<typeof createAircraft>; replacement: ReturnType<typeof createAircraft> } {
      const retired = createAircraft(db, { registration: 'G-OLD', icaoType: 'A320' })
      const replacement = createAircraft(db, { registration: 'G-NEW', icaoType: 'A320' })
      return { retired, replacement }
    }

    it('moves every flight from the retired aircraft onto the replacement and marks it retired', () => {
      const { retired, replacement } = makeAircraftPair()
      const flightOne = createFlight(db, { aircraftId: retired.id, depIcao: 'EGLL', arrIcao: 'EGCC' })
      const flightTwo = createFlight(db, { aircraftId: retired.id, depIcao: 'EGCC', arrIcao: 'EGLL' })
      // An unrelated flight on a third aircraft must be left alone.
      const other = createAircraft(db, { registration: 'G-OTHER', icaoType: 'B738' })
      const untouchedFlight = createFlight(db, { aircraftId: other.id, depIcao: 'EGLL', arrIcao: 'EHAM' })
      const untouchedFlightUpdatedAtBefore = db
        .select()
        .from(flight)
        .where(eq(flight.id, untouchedFlight.id))
        .get()?.updatedAt

      const result = replaceAircraft(db, { retiredId: retired.id, replacementId: replacement.id })

      expect(result.replacedByAircraftId).toBe(replacement.id)
      expect(getAircraftByRegistration(db, 'G-OLD')?.replacedByAircraftId).toBe(replacement.id)

      const movedOne = db.select().from(flight).where(eq(flight.id, flightOne.id)).get()
      const movedTwo = db.select().from(flight).where(eq(flight.id, flightTwo.id)).get()
      expect(movedOne?.aircraftId).toBe(replacement.id)
      expect(movedTwo?.aircraftId).toBe(replacement.id)
      // updatedAt must be bumped on every row this touches (cloud-sync discipline, see the
      // uuid comment in schema.ts) so a future sync picks up both changes.
      expect(movedOne?.updatedAt).not.toBeNull()
      expect(movedTwo?.updatedAt).not.toBeNull()

      const untouched = db.select().from(flight).where(eq(flight.id, untouchedFlight.id)).get()
      expect(untouched?.aircraftId).toBe(other.id)
      expect(untouched?.updatedAt).toBe(untouchedFlightUpdatedAtBefore)

      // The replacement aircraft itself is untouched (still active, not retired).
      expect(getAircraftByRegistration(db, 'G-NEW')?.replacedByAircraftId).toBeNull()
    })

    it('rejects self-replacement', () => {
      const { retired } = makeAircraftPair()
      expect(() => replaceAircraft(db, { retiredId: retired.id, replacementId: retired.id })).toThrow(
        /cannot replace itself/
      )
    })

    it('rejects re-replacing an already-retired aircraft', () => {
      const { retired, replacement } = makeAircraftPair()
      const another = createAircraft(db, { registration: 'G-THIRD', icaoType: 'A320' })
      replaceAircraft(db, { retiredId: retired.id, replacementId: replacement.id })

      expect(() => replaceAircraft(db, { retiredId: retired.id, replacementId: another.id })).toThrow(
        /already been replaced/
      )
    })

    it('rejects a retiredId that does not exist', () => {
      const { replacement } = makeAircraftPair()
      expect(() => replaceAircraft(db, { retiredId: 999_999, replacementId: replacement.id })).toThrow(/not found/)
    })

    it('rejects a replacementId that does not exist', () => {
      const { retired } = makeAircraftPair()
      expect(() => replaceAircraft(db, { retiredId: retired.id, replacementId: 999_999 })).toThrow(/not found/)
    })

    it('does not partially apply on a validation failure — no flights move, no flag set', () => {
      const { retired } = makeAircraftPair()
      createFlight(db, { aircraftId: retired.id, depIcao: 'EGLL', arrIcao: 'EGCC' })

      expect(() => replaceAircraft(db, { retiredId: retired.id, replacementId: 999_999 })).toThrow()

      const stillRetired = getAircraftByRegistration(db, 'G-OLD')
      expect(stillRetired?.replacedByAircraftId).toBeNull()
      const flights = db.select().from(flight).where(eq(flight.aircraftId, retired.id)).all()
      expect(flights).toHaveLength(1)
    })
  })

  describe('retireAircraft / unretireAircraft', () => {
    it('retires an aircraft while keeping its own flights, and bumps updatedAt for sync', () => {
      const a = createAircraft(db, { registration: 'G-KEEP', icaoType: 'A320', currentIcao: 'EGLL' })
      const f = createFlight(db, { aircraftId: a.id, depIcao: 'EGLL', arrIcao: 'EGCC' })
      const before = db.select().from(aircraftTable).where(eq(aircraftTable.id, a.id)).get()

      const result = retireAircraft(db, a.id)

      expect(result.retiredAt).toBeTypeOf('string')
      expect(result.replacedByAircraftId).toBeNull()
      expect(result.currentIcao).toBe('EGLL')
      // History stays on the aircraft itself — the whole point versus replaceAircraft.
      expect(db.select().from(flight).where(eq(flight.id, f.id)).get()?.aircraftId).toBe(a.id)
      const after = db.select().from(aircraftTable).where(eq(aircraftTable.id, a.id)).get()
      expect(after?.retiredAt).toBe(result.retiredAt)
      expect((after?.updatedAt as string) >= (before?.updatedAt as string)).toBe(true)
      expect(after?.updatedAt).toBe(result.retiredAt)
      expect(listAircraft(db).find((x) => x.id === a.id)?.retiredAt).toBe(result.retiredAt)
    })

    it('rejects an unknown id, a soft-deleted aircraft, and an already-retired or replaced one', () => {
      const a = createAircraft(db, { registration: 'G-ONE', icaoType: 'A320' })
      const b = createAircraft(db, { registration: 'G-TWO', icaoType: 'A320' })
      const c = createAircraft(db, { registration: 'G-THREE', icaoType: 'A320' })
      expect(() => retireAircraft(db, 999)).toThrow('Aircraft 999 not found')

      retireAircraft(db, a.id)
      expect(() => retireAircraft(db, a.id)).toThrow('G-ONE is already retired')

      replaceAircraft(db, { retiredId: b.id, replacementId: c.id })
      expect(() => retireAircraft(db, b.id)).toThrow('G-TWO is already retired')

      deleteAircraft(db, c.id)
      expect(() => retireAircraft(db, c.id)).toThrow(`Aircraft ${c.id} not found`)
    })

    it('un-retires a plainly retired aircraft', () => {
      const a = createAircraft(db, { registration: 'G-BACK', icaoType: 'A320' })
      retireAircraft(db, a.id)

      const result = unretireAircraft(db, a.id)

      expect(result.retiredAt).toBeNull()
      expect(db.select().from(aircraftTable).where(eq(aircraftTable.id, a.id)).get()?.retiredAt).toBeNull()
    })

    it('refuses to un-retire an aircraft that is not retired, is missing, or was replaced', () => {
      const a = createAircraft(db, { registration: 'G-LIVE', icaoType: 'A320' })
      const old = createAircraft(db, { registration: 'G-GONE', icaoType: 'A320' })
      replaceAircraft(db, { retiredId: old.id, replacementId: a.id })

      expect(() => unretireAircraft(db, a.id)).toThrow('G-LIVE is not retired')
      expect(() => unretireAircraft(db, 999)).toThrow('Aircraft 999 not found')
      // Its flights already moved to the replacement — reactivating it would be an empty duplicate.
      expect(() => unretireAircraft(db, old.id)).toThrow("G-GONE was replaced and can't be un-retired")
    })

    it('throws these business-rule messages in the active main-process language, not always English', () => {
      setMainLanguage('de', 'en-US')
      const a = createAircraft(db, { registration: 'G-ONE', icaoType: 'A320' })
      retireAircraft(db, a.id)
      expect(() => retireAircraft(db, a.id)).toThrow('G-ONE ist bereits ausgemustert')
    })
  })
})
