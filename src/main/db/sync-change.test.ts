/**
 * The change counter's guard tests (winglog-backend docs/plans/sync-cursors.md). drizzle-kit does not know about triggers, so a later migration
 * that recreates one of the four synced tables would drop its triggers without a word, and sync would quietly stop seeing changes. These tests
 * fail if that happens, and check that the repo functions the app really writes with each leave a mark.
 */
import { readFileSync } from 'node:fs'
import { and, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createAircraft,
  deleteAircraft,
  replaceAircraft,
  retireAircraft,
  updateAircraft
} from './aircraft-repo'
import { mergeEmptyAircraft } from './aircraft-merge-repo'
import { createDb, type WingLogDb } from './client'
import { addInvoicesForFlight } from './flight-invoice-repo'
import { createFlight, deleteFlight, setFlownRoute } from './flight-repo'
import { createLanding } from './landing-repo'
import { aircraft, flight, flightInvoice, landing, syncChange } from './schema'

describe('the sync change counter', () => {
  let db: WingLogDb
  let sqlite: ReturnType<typeof createDb>['sqlite']

  beforeEach(() => {
    const created = createDb(':memory:')
    migrate(created.db, { migrationsFolder: 'drizzle' })
    db = created.db
    sqlite = created.sqlite
  })

  const seqOf = (tableName: string, uuid: string): number | undefined =>
    db
      .select()
      .from(syncChange)
      .where(and(eq(syncChange.tableName, tableName), eq(syncChange.uuid, uuid)))
      .get()?.seq

  const uuidOf = (table: 'aircraft' | 'flight', id: number): string =>
    (table === 'aircraft'
      ? db.select().from(aircraft).where(eq(aircraft.id, id)).get()?.uuid
      : db.select().from(flight).where(eq(flight.id, id)).get()?.uuid) as string

  const LANDING = {
    seq: 1,
    icao: null,
    touchdownTsUtc: '2026-04-12T23:30:00.000Z',
    verticalSpeedMs: -1.2,
    gForce: 1.3,
    pitchDeg: 2,
    bankDeg: 0.5,
    headingTrueDeg: 270,
    indicatedAirspeedMs: 70,
    groundSpeedMs: 68,
    windSpeedMs: 5,
    windDirectionDeg: 260,
    headwindMs: null,
    crosswindMs: null,
    crabDeg: null,
    runwayIdent: null,
    distanceFromThresholdM: null,
    centrelineOffsetM: null,
    flapSetting: null,
    touchdownSource: 'derived',
    runwaySource: null
  } as const

  const RECEIPT = {
    serviceGroup: 'fuel',
    receiptId: 'r1',
    issuedUtc: '2026-04-12T22:00:00Z',
    icao: 'EGLL',
    tail: 'G-ABCD',
    operator: null,
    totalUsd: 1,
    totalText: '£1',
    sourceHtmlPath: '/tmp/r1.html',
    receiptJson: '{}'
  } as const

  describe('the guard', () => {
    it('has an insert, an update and a delete trigger on each of the four synced tables', () => {
      const names = (
        sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as {
          name: string
        }[]
      ).map((row) => row.name)
      const expected = ['aircraft', 'flight', 'landing', 'flight_invoice'].flatMap((table) =>
        ['insert', 'update', 'delete'].map((kind) => `sync_change_${table}_${kind}`)
      )
      expect(names).toEqual(expected.sort())
    })

    it('numbers the rows a database already had, oldest first, when the migration runs', () => {
      // The migration's own backfill statements, run again over rows the triggers had already counted.
      const plane = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' })
      const trip = createFlight(db, { aircraftId: plane.id, depIcao: 'EGLL', arrIcao: 'EGCC' })
      db.update(aircraft)
        .set({ updatedAt: '2026-01-02T00:00:00.000Z' })
        .where(eq(aircraft.id, plane.id))
        .run()
      db.update(flight).set({ updatedAt: '2026-01-01T00:00:00.000Z' }).where(eq(flight.id, trip.id)).run()
      sqlite.exec('DELETE FROM sync_change')

      const migration = readFileSync('drizzle/0043_sync_change_triggers.sql', 'utf8')
      const backfill = migration
        .split('--> statement-breakpoint')
        .filter((statement) => /^\s*INSERT INTO sync_change/.test(statement))
      expect(backfill).toHaveLength(4)
      for (const statement of backfill) sqlite.exec(statement)

      const rows = db.select().from(syncChange).all()
      expect(rows.map((row) => `${row.tableName}:${row.uuid}`).sort()).toEqual(
        [`aircraft:${uuidOf('aircraft', plane.id)}`, `flight:${uuidOf('flight', trip.id)}`].sort()
      )
      expect(rows.every((row) => row.origin === null)).toBe(true)
    })
  })

  describe('every way the app writes a synced row leaves a mark', () => {
    it('creating an aircraft, a flight, a landing and a receipt', () => {
      const plane = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' })
      const trip = createFlight(db, { aircraftId: plane.id, depIcao: 'EGLL', arrIcao: 'EGCC' })
      createLanding(db, { flightId: trip.id, ...LANDING })
      addInvoicesForFlight(db, trip.id, [RECEIPT])

      expect(seqOf('aircraft', uuidOf('aircraft', plane.id))).toBeDefined()
      expect(seqOf('flight', uuidOf('flight', trip.id))).toBeDefined()
      const landingRow = db.select().from(landing).get()
      const invoiceRow = db.select().from(flightInvoice).get()
      expect(seqOf('landing', landingRow?.uuid as string)).toBeDefined()
      expect(seqOf('flightInvoice', invoiceRow?.uuid as string)).toBeDefined()
    })

    it('editing, retiring and replacing an aircraft, and setting a flight’s flown route', () => {
      const plane = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' })
      const other = createAircraft(db, { registration: 'G-WXYZ', icaoType: 'A320' })
      const trip = createFlight(db, { aircraftId: plane.id, depIcao: 'EGLL', arrIcao: 'EGCC' })
      const planeUuid = uuidOf('aircraft', plane.id)
      const tripUuid = uuidOf('flight', trip.id)

      let before = seqOf('aircraft', planeUuid) as number
      updateAircraft(db, { id: plane.id, registration: 'G-ABCE', icaoType: 'A320' } as never)
      expect(seqOf('aircraft', planeUuid)).toBeGreaterThan(before)

      before = seqOf('flight', tripUuid) as number
      setFlownRoute(db, trip.id, '[]')
      expect(seqOf('flight', tripUuid)).toBeGreaterThan(before)

      before = seqOf('aircraft', uuidOf('aircraft', other.id)) as number
      retireAircraft(db, other.id)
      expect(seqOf('aircraft', uuidOf('aircraft', other.id))).toBeGreaterThan(before)

      before = seqOf('flight', tripUuid) as number
      const replacement = createAircraft(db, { registration: 'G-NEW1', icaoType: 'A320' })
      replaceAircraft(db, { retiredId: plane.id, replacementId: replacement.id })
      expect(seqOf('flight', tripUuid)).toBeGreaterThan(before) // its flights moved to the replacement
    })

    it('deleting a flight marks the flight and the landing and receipt under it', () => {
      const plane = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' })
      const trip = createFlight(db, { aircraftId: plane.id, depIcao: 'EGLL', arrIcao: 'EGCC' })
      createLanding(db, { flightId: trip.id, ...LANDING })
      addInvoicesForFlight(db, trip.id, [RECEIPT])
      const landingUuid = db.select().from(landing).get()?.uuid as string
      const invoiceUuid = db.select().from(flightInvoice).get()?.uuid as string
      const before = [
        seqOf('flight', uuidOf('flight', trip.id)),
        seqOf('landing', landingUuid),
        seqOf('flightInvoice', invoiceUuid)
      ] as number[]

      deleteFlight(db, trip.id)

      expect(seqOf('flight', uuidOf('flight', trip.id))).toBeGreaterThan(before[0])
      expect(seqOf('landing', landingUuid)).toBeGreaterThan(before[1])
      expect(seqOf('flightInvoice', invoiceUuid)).toBeGreaterThan(before[2])
    })

    it('soft-deleting an aircraft', () => {
      const plane = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' })
      const before = seqOf('aircraft', uuidOf('aircraft', plane.id)) as number
      deleteAircraft(db, plane.id)
      expect(seqOf('aircraft', uuidOf('aircraft', plane.id))).toBeGreaterThan(before)
    })
  })

  describe('the counter itself', () => {
    it('keeps one entry per row, always with a higher number than before, and resets origin when the row is changed here', () => {
      const plane = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' })
      const uuid = uuidOf('aircraft', plane.id)
      const first = seqOf('aircraft', uuid) as number
      db.update(syncChange).set({ origin: 'cloud' }).where(eq(syncChange.uuid, uuid)).run()

      updateAircraft(db, { id: plane.id, registration: 'G-ABCE', icaoType: 'A320' } as never)
      updateAircraft(db, { id: plane.id, registration: 'G-ABCF', icaoType: 'A320' } as never)

      const entries = db.select().from(syncChange).where(eq(syncChange.uuid, uuid)).all()
      expect(entries).toHaveLength(1)
      expect(entries[0].seq).toBeGreaterThan(first + 1)
      expect(entries[0].origin).toBeNull()
    })

    it('never reuses a number, even after the highest entry is gone', () => {
      const a = createAircraft(db, { registration: 'G-AAAA', icaoType: 'A320' })
      const b = createAircraft(db, { registration: 'G-BBBB', icaoType: 'A320' })
      const highest = seqOf('aircraft', uuidOf('aircraft', b.id)) as number
      sqlite.prepare('DELETE FROM aircraft WHERE id = ?').run(b.id)
      const c = createAircraft(db, { registration: 'G-CCCC', icaoType: 'A320' })
      expect(seqOf('aircraft', uuidOf('aircraft', c.id))).toBeGreaterThan(highest)
      expect(seqOf('aircraft', uuidOf('aircraft', a.id))).toBeLessThan(highest)
    })

    it('drops an aircraft’s entry when its row is deleted outright, as a fold of an empty copy does', () => {
      const real = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' })
      const copy = createAircraft(db, { registration: 'G-OLDX', icaoType: 'A320' })
      const copyUuid = uuidOf('aircraft', copy.id)
      expect(seqOf('aircraft', copyUuid)).toBeDefined()

      mergeEmptyAircraft(db, copy.id, real.id)

      expect(seqOf('aircraft', copyUuid)).toBeUndefined()
      expect(seqOf('aircraft', uuidOf('aircraft', real.id))).toBeDefined()
    })

    it('does not count a row that has no uuid yet', () => {
      sqlite
        .prepare(
          "INSERT INTO aircraft (registration, icao_type, created_at) VALUES ('G-NOID', 'A320', '2026-01-01')"
        )
        .run()
      expect(db.select().from(syncChange).all()).toEqual([])
    })
  })
})
