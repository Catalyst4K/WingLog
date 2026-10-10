import { readFileSync, rmSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAircraft, deleteAircraft, listAircraft, replaceAircraft } from '../db/aircraft-repo'
import { createDb, type WingLogDb } from '../db/client'
import { addInvoicesForFlight, listInvoicesForFlight } from '../db/flight-invoice-repo'
import { createFlight } from '../db/flight-repo'
import { createLanding, getLandingByFlight } from '../db/landing-repo'
import { getLastSyncedAt } from '../db/settings-repo'
import { aircraft, flight, flightInvoice } from '../db/schema'
import type { SyncRow, SyncTable } from '../backend/sync-client'
import { MAX_PUSH_ROWS, MAX_ROW_DATA_BYTES, runSync, splitPushBatches, type SyncClient } from './sync-engine'

/** A high-fidelity fake of winglog-backend's real UserStore.push/pull semantics
 *  (last-write-wins on updatedAt, filter-by-since on pull) — see winglog-backend's
 *  src/user-store.ts, which this deliberately mirrors rather than reinventing. */
class FakeSyncServer implements SyncClient {
  private rows = new Map<SyncTable, Map<string, SyncRow>>()

  async syncPull(_email: string, _token: string, table: SyncTable, since: string | null): Promise<SyncRow[]> {
    const rows = [...(this.rows.get(table)?.values() ?? [])]
    return rows
      .filter((r) => since === null || r.updatedAt > since)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
  }

  async syncPush(
    _email: string,
    _token: string,
    table: SyncTable,
    rows: SyncRow[]
  ): Promise<{ upserted: string[]; rejected: string[] }> {
    const store = this.rows.get(table) ?? new Map<string, SyncRow>()
    const upserted: string[] = []
    const rejected: string[] = []
    for (const row of rows) {
      const existing = store.get(row.uuid)
      if (existing && existing.updatedAt >= row.updatedAt) {
        rejected.push(row.uuid)
        continue
      }
      store.set(row.uuid, row)
      upserted.push(row.uuid)
    }
    this.rows.set(table, store)
    return { upserted, rejected }
  }

  /** Test helper: seed a row directly, as if another device already pushed it. */
  seed(table: SyncTable, row: SyncRow): void {
    const store = this.rows.get(table) ?? new Map<string, SyncRow>()
    store.set(row.uuid, row)
    this.rows.set(table, store)
  }
}

const SESSION = { email: 'callum@example.com', token: 'test-token' }

describe('sync-engine', () => {
  let db: WingLogDb
  let tempDir: string
  let dbPath: string
  let server: FakeSyncServer

  beforeEach(() => {
    const created = createDb(':memory:')
    migrate(created.db, { migrationsFolder: 'drizzle' })
    db = created.db
    tempDir = mkdtempSync(join(tmpdir(), 'winglog-sync-test-'))
    dbPath = join(tempDir, 'winglog.db')
    server = new FakeSyncServer()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('pushes a newly created local aircraft to the server', async () => {
    createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' })

    const result = await runSync(db, server, SESSION, dbPath)

    expect(result.tables.aircraft.pushed).toBe(1)
    const pulled = await server.syncPull(SESSION.email, SESSION.token, 'aircraft', null)
    expect(pulled).toHaveLength(1)
    expect(JSON.parse(pulled[0].data)).toMatchObject({ registration: 'G-ABCD', icaoType: 'A320' })
  })

  it('pulls a server-side aircraft into the local database', async () => {
    server.seed('aircraft', {
      uuid: 'remote-uuid-1',
      updatedAt: '2026-09-04T10:00:00.000Z',
      data: JSON.stringify({
        registration: 'G-REMOTE',
        icaoType: 'B738',
        operator: null,
        operatorIata: null,
        operatorIcao: null,
        simbriefAirframeId: null,
        simbriefType: null,
        currentIcao: null,
        createdAt: '2026-09-04T10:00:00.000Z'
      })
    })

    const result = await runSync(db, server, SESSION, dbPath)

    expect(result.tables.aircraft.pulled).toBe(1)
    const row = db.select().from(aircraft).where(eq(aircraft.uuid, 'remote-uuid-1')).get()
    expect(row).toBeDefined()
  })

  it('advances lastSyncedAt only after a table syncs cleanly', async () => {
    expect(getLastSyncedAt(db, 'aircraft')).toBeNull()
    await runSync(db, server, SESSION, dbPath)
    expect(getLastSyncedAt(db, 'aircraft')).not.toBeNull()
  })

  it('logs a rejected (last-write-wins loser) push to sync-conflicts.log instead of dropping it silently', async () => {
    // Seed the server with a *newer* version of the same uuid the local push will use —
    // simulates another device having already won this row's last edit.
    const created = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' })
    const localRow = db.select().from(aircraft).where(eq(aircraft.id, created.id)).get()!
    server.seed('aircraft', {
      uuid: localRow.uuid as string,
      updatedAt: '2099-01-01T00:00:00.000Z', // far in the future — always wins
      data: JSON.stringify({ registration: 'G-ABCD', icaoType: 'A320' })
    })

    const result = await runSync(db, server, SESSION, dbPath)

    expect(result.tables.aircraft.rejected).toEqual([localRow.uuid])
    const log = readFileSync(join(tempDir, 'sync-conflicts.log'), 'utf-8')
    expect(log).toContain(localRow.uuid as string)
    expect(log).toContain('last-write-wins')
  })

  it("translates a flight-invoice's flightId to the parent flight's uuid on push, and back to a local id on pull", async () => {
    const createdAircraft = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' })
    const createdFlight = createFlight(db, {
      aircraftId: createdAircraft.id,
      depIcao: 'EGLL',
      arrIcao: 'EGKK'
    })
    addInvoicesForFlight(db, createdFlight.id, [
      {
        serviceGroup: 'fuel',
        receiptId: 'r1',
        issuedUtc: '2026-09-04T09:00:00Z',
        icao: 'EGLL',
        tail: 'G-ABCD',
        operator: null,
        totalUsd: 100,
        totalText: '£80',
        sourceHtmlPath: '/tmp/r1.html',
        receiptJson: '{}'
      }
    ])

    await runSync(db, server, SESSION, dbPath)

    const pushedInvoices = await server.syncPull(SESSION.email, SESSION.token, 'flightInvoice', null)
    expect(pushedInvoices).toHaveLength(1)
    const data = JSON.parse(pushedInvoices[0].data) as Record<string, unknown>
    expect(data.flightUuid).toBeTypeOf('string')
    expect(data.flightId).toBeUndefined() // the local, meaningless-remotely id must not leak onto the wire

    // A second "device": fresh local DB, pull the same server state.
    const created2 = createDb(':memory:')
    migrate(created2.db, { migrationsFolder: 'drizzle' })
    const secondDbPath = join(tempDir, 'second.db')
    // Pull aircraft and flight first (dependency order), same as runSync does internally.
    await runSync(created2.db, server, SESSION, secondDbPath)

    const invoiceRow = created2.db.select().from(flightInvoice).get()
    expect(invoiceRow).toBeDefined()
    const flightRow = created2.db.select().from(flight).get()
    expect(invoiceRow?.flightId).toBe(flightRow?.id)
  })

  it('propagates a change created on a second profile back to a first, already-synced profile (reverse direction)', async () => {
    // "profile A" pulls first so it has nothing yet; "profile B" is where the edit happens.
    const dbB = createDb(':memory:')
    migrate(dbB.db, { migrationsFolder: 'drizzle' })
    const dbPathB = join(tempDir, 'profile-b.db')

    createAircraft(dbB.db, { registration: 'G-REVB', icaoType: 'A321' })
    const resultB = await runSync(dbB.db, server, SESSION, dbPathB)
    expect(resultB.tables.aircraft.pushed).toBe(1)

    // profile A (the suite's own `db`) had never seen this uuid before.
    const resultA = await runSync(db, server, SESSION, dbPath)
    expect(resultA.tables.aircraft.pulled).toBe(1)
    const row = db.select().from(aircraft).where(eq(aircraft.registration, 'G-REVB')).get()
    expect(row).toBeDefined()
    expect(row?.icaoType).toBe('A321')
  })

  it('resolves a same-row conflict by last-write-wins on updatedAt, not by which profile happens to sync second', async () => {
    // Both profiles start from the same already-synced aircraft row.
    const created = createAircraft(db, { registration: 'G-ORIG', icaoType: 'A320' })
    const firstSync = await runSync(db, server, SESSION, dbPath)
    expect(firstSync.tables.aircraft.pushed).toBe(1)
    const syncedUuid = db
      .select({ uuid: aircraft.uuid })
      .from(aircraft)
      .where(eq(aircraft.id, created.id))
      .get()!.uuid as string

    const dbB = createDb(':memory:')
    migrate(dbB.db, { migrationsFolder: 'drizzle' })
    const dbPathB = join(tempDir, 'profile-b-conflict.db')
    await runSync(dbB.db, server, SESSION, dbPathB) // profile B pulls the same row

    // Both profiles now edit the same uuid offline, before either syncs again. Profile B's
    // edit is the chronologically later one (later updatedAt) — last-write-wins says B's
    // registration should be the one that survives, regardless of sync order.
    const baseline = firstSync.syncedAt
    const olderEdit = new Date(new Date(baseline).getTime() + 1000).toISOString() // profile A
    const newerEdit = new Date(new Date(baseline).getTime() + 5000).toISOString() // profile B

    db.update(aircraft)
      .set({ registration: 'G-FROM-A', updatedAt: olderEdit })
      .where(eq(aircraft.uuid, syncedUuid))
      .run()
    dbB.db
      .update(aircraft)
      .set({ registration: 'G-FROM-B', updatedAt: newerEdit })
      .where(eq(aircraft.uuid, syncedUuid))
      .run()

    // Sync profile A first (pushes its older edit), then profile B (pulls A's edit, but
    // must not let it clobber B's own, genuinely newer, unsynced edit).
    await runSync(db, server, SESSION, dbPath)
    const resultB = await runSync(dbB.db, server, SESSION, dbPathB)

    // Profile B's local row must still read its own edit — not overwritten by the older
    // pulled-in value from profile A.
    const rowB = dbB.db.select().from(aircraft).where(eq(aircraft.uuid, syncedUuid)).get()
    expect(rowB?.registration).toBe('G-FROM-B')
    // The rejected pull must be visible/logged, not silently swallowed.
    expect(resultB.tables.aircraft.rejected).toContain(syncedUuid)
    const logB = readFileSync(join(dirname(dbPathB), 'sync-conflicts.log'), 'utf-8')
    expect(logB).toContain(syncedUuid)
    expect(logB).toContain('last-write-wins')

    // Profile B's genuinely-newer edit must actually reach the server, not just survive
    // locally — otherwise the next device to sync would never see it.
    const serverRows = await server.syncPull(SESSION.email, SESSION.token, 'aircraft', null)
    const serverRow = serverRows.find((r) => r.uuid === syncedUuid)
    expect(serverRow).toBeDefined()
    expect(JSON.parse(serverRow!.data)).toMatchObject({ registration: 'G-FROM-B' })

    // And a later sync on profile A converges it onto B's winning edit.
    await runSync(db, server, SESSION, dbPath)
    const rowA = db.select().from(aircraft).where(eq(aircraft.uuid, syncedUuid)).get()
    expect(rowA?.registration).toBe('G-FROM-B')
  })

  // The real bug this closes (winglog-backend/docs/plans/cloud-sync-v2.md #3a): a hard
  // DELETE is indistinguishable from "never created" once it crosses the sync protocol, so
  // a pull resurrects it on every other device. Confirms the tombstone fix end to end
  // across two profiles, including the specific "further sync on the deleting profile
  // itself doesn't undo its own deletion" case.
  it('propagates a deletion to a second profile instead of the next pull resurrecting it', async () => {
    const created = createAircraft(db, { registration: 'G-DELME', icaoType: 'A320' })
    await runSync(db, server, SESSION, dbPath) // profile A pushes the aircraft

    const dbB = createDb(':memory:')
    migrate(dbB.db, { migrationsFolder: 'drizzle' })
    const dbPathB = join(tempDir, 'profile-b-delete.db')
    await runSync(dbB.db, server, SESSION, dbPathB) // profile B pulls it
    expect(listAircraft(dbB.db).map((a) => a.registration)).toContain('G-DELME')

    deleteAircraft(db, created.id) // profile A deletes it locally
    expect(listAircraft(db)).toEqual([]) // gone locally, immediately

    await runSync(db, server, SESSION, dbPath) // profile A pushes the tombstone
    const resultB = await runSync(dbB.db, server, SESSION, dbPathB) // profile B pulls it

    expect(resultB.tables.aircraft.pulled).toBe(1) // the tombstone update itself is a pull
    expect(listAircraft(dbB.db)).toEqual([]) // deleted on B too, not resurrected

    // The scenario the bug actually produced: syncing profile A again (nothing new to
    // push/pull) must not somehow bring the aircraft back on A either.
    await runSync(db, server, SESSION, dbPath)
    expect(listAircraft(db)).toEqual([])
  })

  it('skips a landing whose parent flight has not been synced, without aborting the rest of the table', async () => {
    server.seed('landing', {
      uuid: 'orphan-landing',
      updatedAt: '2026-09-04T10:00:00.000Z',
      data: JSON.stringify({ flightUuid: 'no-such-flight', touchdownTsUtc: '2026-09-04T10:00:00Z' })
    })

    const result = await runSync(db, server, SESSION, dbPath)

    expect(result.tables.landing.skipped).toEqual(['orphan-landing'])
    expect(getLandingByFlight(db, 1)).toBeUndefined()
  })

  it('skips an aircraft, flight, or flightInvoice pull with malformed/missing required fields', async () => {
    server.seed('aircraft', {
      uuid: 'bad-aircraft',
      updatedAt: '2026-09-04T10:00:00.000Z',
      data: JSON.stringify({ registration: 'G-BAD' }) // icaoType missing
    })
    server.seed('flight', {
      uuid: 'bad-flight',
      updatedAt: '2026-09-04T10:00:00.000Z',
      data: JSON.stringify({ aircraftUuid: 'whatever' }) // depIcao/arrIcao missing
    })
    server.seed('flightInvoice', {
      uuid: 'bad-invoice',
      updatedAt: '2026-09-04T10:00:00.000Z',
      data: JSON.stringify({ flightUuid: 'whatever' }) // receiptId missing
    })

    const result = await runSync(db, server, SESSION, dbPath)

    expect(result.tables.aircraft.skipped).toEqual(['bad-aircraft'])
    expect(result.tables.flight.skipped).toEqual(['bad-flight'])
    expect(result.tables.flightInvoice.skipped).toEqual(['bad-invoice'])
  })

  it('skips a pulled flight referencing an aircraft uuid that was never synced', async () => {
    server.seed('flight', {
      uuid: 'flight-for-unknown-aircraft',
      updatedAt: '2026-09-04T10:00:00.000Z',
      data: JSON.stringify({ aircraftUuid: 'no-such-aircraft', depIcao: 'EGLL', arrIcao: 'EGCC' })
    })

    const result = await runSync(db, server, SESSION, dbPath)

    expect(result.tables.flight.skipped).toEqual(['flight-for-unknown-aircraft'])
  })

  it('skips an invalid (unparseable JSON) pulled row rather than throwing', async () => {
    server.seed('aircraft', {
      uuid: 'bad-json',
      updatedAt: '2026-09-04T10:00:00.000Z',
      data: 'not json at all'
    })

    const result = await runSync(db, server, SESSION, dbPath)

    expect(result.tables.aircraft.skipped).toEqual(['bad-json'])
  })

  it('skips a pulled row whose data is valid JSON but not an object (e.g. a bare number)', async () => {
    server.seed('aircraft', { uuid: 'not-an-object', updatedAt: '2026-09-04T10:00:00.000Z', data: '42' })

    const result = await runSync(db, server, SESSION, dbPath)

    expect(result.tables.aircraft.skipped).toEqual(['not-an-object'])
  })

  it('skips a pulled landing missing its required flightUuid field', async () => {
    server.seed('landing', {
      uuid: 'landing-no-flight-uuid',
      updatedAt: '2026-09-04T10:00:00.000Z',
      data: JSON.stringify({ touchdownTsUtc: '2026-09-04T10:00:00Z' })
    })

    const result = await runSync(db, server, SESSION, dbPath)

    expect(result.tables.landing.skipped).toEqual(['landing-no-flight-uuid'])
  })

  it('does not push a flight whose own aircraft has no uuid yet, and retries it next sync', async () => {
    const createdAircraft = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' })
    db.update(aircraft).set({ uuid: null }).where(eq(aircraft.id, createdAircraft.id)).run()
    createFlight(db, { aircraftId: createdAircraft.id, depIcao: 'EGLL', arrIcao: 'EGCC' })

    const result = await runSync(db, server, SESSION, dbPath)

    expect(result.tables.flight.pushed).toBe(0)
    expect(await server.syncPull(SESSION.email, SESSION.token, 'flight', null)).toEqual([])
  })

  it('reports a real DB failure (unique constraint) applying a pulled row as skipped, not a crash', async () => {
    // A known aircraft renamed on another device to a registration this device already has on a
    // different aircraft, so the update collides with the unique constraint.
    createAircraft(db, { registration: 'G-DUPE', icaoType: 'A320' })
    const other = createAircraft(db, { registration: 'G-OTHR', icaoType: 'A320' })
    const otherUuid = db.select().from(aircraft).where(eq(aircraft.id, other.id)).get()!.uuid as string
    server.seed('aircraft', {
      uuid: otherUuid,
      updatedAt: '2099-01-01T00:00:00.000Z',
      data: JSON.stringify({ registration: 'G-DUPE', icaoType: 'B738' })
    })

    const result = await runSync(db, server, SESSION, dbPath)

    expect(result.tables.aircraft.skipped).toEqual([otherUuid])
    expect(
      listAircraft(db)
        .map((a) => a.registration)
        .sort()
    ).toEqual(['G-DUPE', 'G-OTHR'])
  })

  it('reports a real DB failure applying a pulled landing (missing NOT NULL fields) as skipped', async () => {
    const createdAircraft = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' })
    const createdFlight = createFlight(db, {
      aircraftId: createdAircraft.id,
      depIcao: 'EGLL',
      arrIcao: 'EGCC'
    })
    await runSync(db, server, SESSION, dbPath) // so the flight has a synced uuid to reference
    const flightUuid = db
      .select({ uuid: flight.uuid })
      .from(flight)
      .where(eq(flight.id, createdFlight.id))
      .get()!.uuid as string

    server.seed('landing', {
      uuid: 'incomplete-landing',
      // After the uuid-establishing sync above, this table's cursor has already advanced —
      // a fixed past timestamp would be filtered out by the fake server's own since-filter,
      // same as a real one would.
      updatedAt: '2099-01-01T00:00:00.000Z',
      data: JSON.stringify({ flightUuid }) // every other NOT NULL landing field is missing
    })

    const result = await runSync(db, server, SESSION, dbPath)

    expect(result.tables.landing.skipped).toEqual(['incomplete-landing'])
  })

  it('pushes a locally created landing, translating its flightId to the parent flight uuid', async () => {
    const createdAircraft = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' })
    const createdFlight = createFlight(db, {
      aircraftId: createdAircraft.id,
      depIcao: 'EGLL',
      arrIcao: 'EGCC'
    })
    createLanding(db, {
      flightId: createdFlight.id,
      seq: 1,
      icao: null,
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
      headwindMs: null,
      crosswindMs: null,
      crabDeg: null,
      runwayIdent: null,
      distanceFromThresholdM: null,
      centrelineOffsetM: null,
      flapSetting: null,
      touchdownSource: 'derived'
    })

    const result = await runSync(db, server, SESSION, dbPath)

    expect(result.tables.landing.pushed).toBe(1)
    const pushed = await server.syncPull(SESSION.email, SESSION.token, 'landing', null)
    expect(pushed).toHaveLength(1)
    const data = JSON.parse(pushed[0].data) as Record<string, unknown>
    expect(data.flightUuid).toBeTypeOf('string')
    expect(data.flightId).toBeUndefined()
  })

  it('does not push a landing or flightInvoice whose parent flight has no uuid yet, and retries it next sync', async () => {
    const createdAircraft = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' })
    const createdFlight = createFlight(db, {
      aircraftId: createdAircraft.id,
      depIcao: 'EGLL',
      arrIcao: 'EGCC'
    })
    // Simulate a flight row with no uuid yet (schema.ts's uuid/updatedAt are nullable for
    // exactly this kind of pre-existing-row edge case) — serializeLanding/
    // serializeFlightInvoice must skip it rather than push a broken reference.
    db.update(flight).set({ uuid: null }).where(eq(flight.id, createdFlight.id)).run()
    createLanding(db, {
      seq: 1,
      flightId: createdFlight.id,
      icao: null,
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
      headwindMs: null,
      crosswindMs: null,
      crabDeg: null,
      runwayIdent: null,
      distanceFromThresholdM: null,
      centrelineOffsetM: null,
      flapSetting: null,
      touchdownSource: 'derived'
    })
    addInvoicesForFlight(db, createdFlight.id, [
      {
        serviceGroup: 'fuel',
        receiptId: 'r1',
        issuedUtc: '2026-09-04T09:00:00Z',
        icao: 'EGLL',
        tail: 'G-ABCD',
        operator: null,
        totalUsd: 100,
        totalText: '£80',
        sourceHtmlPath: '/tmp/r1.html',
        receiptJson: '{}'
      }
    ])

    const result = await runSync(db, server, SESSION, dbPath)

    expect(result.tables.landing.pushed).toBe(0)
    expect(result.tables.flightInvoice.pushed).toBe(0)
    expect(await server.syncPull(SESSION.email, SESSION.token, 'landing', null)).toEqual([])
    expect(listInvoicesForFlight(db, createdFlight.id)).toHaveLength(1) // still there locally
  })

  it('reports a real DB failure applying a pulled flightInvoice (missing NOT NULL fields) as skipped', async () => {
    const createdAircraft = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' })
    const createdFlight = createFlight(db, {
      aircraftId: createdAircraft.id,
      depIcao: 'EGLL',
      arrIcao: 'EGCC'
    })
    await runSync(db, server, SESSION, dbPath)
    const flightUuid = db
      .select({ uuid: flight.uuid })
      .from(flight)
      .where(eq(flight.id, createdFlight.id))
      .get()!.uuid as string

    server.seed('flightInvoice', {
      uuid: 'incomplete-invoice',
      updatedAt: '2099-01-01T00:00:00.000Z', // see the landing test above for why not a past date
      data: JSON.stringify({ flightUuid, receiptId: 'RCPT-INCOMPLETE' }) // sourceHtmlPath etc. missing
    })

    const result = await runSync(db, server, SESSION, dbPath)

    expect(result.tables.flightInvoice.skipped).toEqual(['incomplete-invoice'])
  })

  it('skips a flightInvoice pull referencing a flight uuid that was never synced', async () => {
    server.seed('flightInvoice', {
      uuid: 'invoice-for-unknown-flight',
      updatedAt: '2026-09-04T10:00:00.000Z',
      data: JSON.stringify({ flightUuid: 'no-such-flight', receiptId: 'RCPT-X' })
    })

    const result = await runSync(db, server, SESSION, dbPath)

    expect(result.tables.flightInvoice.skipped).toEqual(['invoice-for-unknown-flight'])
  })
  describe('a pulled row is checked against its table before it is written', () => {
    it('never lets a pulled row choose its own local id', async () => {
      const mine = createAircraft(db, { registration: 'G-MINE', icaoType: 'A320' })
      server.seed('aircraft', {
        uuid: 'planted-id',
        updatedAt: '2099-01-01T00:00:00.000Z',
        data: JSON.stringify({ id: mine.id, registration: 'G-PLNT', icaoType: 'B738' })
      })

      await runSync(db, server, SESSION, dbPath)

      const registrations = db
        .select({ r: aircraft.registration })
        .from(aircraft)
        .all()
        .map((a) => a.r)
      expect(registrations.sort()).toEqual(['G-MINE', 'G-PLNT'])
    })

    it('skips a flight with a number column holding text, and logs why', async () => {
      const a = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' })
      await runSync(db, server, SESSION, dbPath)
      const aircraftUuid = db
        .select({ uuid: aircraft.uuid })
        .from(aircraft)
        .where(eq(aircraft.id, a.id))
        .get()!.uuid as string
      server.seed('flight', {
        uuid: 'bad-fuel',
        updatedAt: '2099-01-01T00:00:00.000Z',
        data: JSON.stringify({ aircraftUuid, depIcao: 'EGLL', arrIcao: 'EGKK', fuelOutKg: 'lots' })
      })

      const result = await runSync(db, server, SESSION, dbPath)

      expect(result.tables.flight.skipped).toEqual(['bad-fuel'])
      expect(db.select().from(flight).all()).toHaveLength(0)
      expect(readFileSync(join(dirname(dbPath), 'sync-conflicts.log'), 'utf8')).toContain(
        'invalid flight data: fuelOutKg must be a finite number'
      )
    })

    it('skips a receipt whose stored path is not text', async () => {
      const a = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' })
      const f = createFlight(db, { aircraftId: a.id, depIcao: 'EGLL', arrIcao: 'EGCC' })
      await runSync(db, server, SESSION, dbPath)
      const flightUuid = db.select({ uuid: flight.uuid }).from(flight).where(eq(flight.id, f.id)).get()!
        .uuid as string
      server.seed('flightInvoice', {
        uuid: 'bad-path',
        updatedAt: '2099-01-01T00:00:00.000Z',
        data: JSON.stringify({
          flightUuid,
          serviceGroup: 'fuel',
          receiptId: 'R1',
          issuedUtc: '2026-09-04T09:00:00Z',
          icao: 'EGLL',
          tail: 'G-ABCD',
          sourceHtmlPath: ['C:\\Windows\\system32\\calc.exe'],
          receiptJson: '{}'
        })
      })

      const result = await runSync(db, server, SESSION, dbPath)

      expect(result.tables.flightInvoice.skipped).toEqual(['bad-path'])
    })

    it('ignores a field the table does not have rather than failing the row', async () => {
      server.seed('aircraft', {
        uuid: 'newer-app',
        updatedAt: '2099-01-01T00:00:00.000Z',
        data: JSON.stringify({ registration: 'G-NEWR', icaoType: 'A21N', fieldFromTheFuture: true })
      })

      const result = await runSync(db, server, SESSION, dbPath)

      expect(result.tables.aircraft.skipped).toEqual([])
      expect(listAircraft(db).map((x) => x.registration)).toContain('G-NEWR')
    })
  })
  describe('a replaced aircraft', () => {
    it('keeps its replacement on a second device, whatever the local ids are there', async () => {
      const old = createAircraft(db, { registration: 'G-OLD1', icaoType: 'A320' })
      const next = createAircraft(db, { registration: 'G-NEW1', icaoType: 'A320' })
      replaceAircraft(db, { retiredId: old.id, replacementId: next.id })
      await runSync(db, server, SESSION, dbPath)
      const pushed = (await server.syncPull(SESSION.email, SESSION.token, 'aircraft', null)).map(
        (r) => JSON.parse(r.data) as Record<string, unknown>
      )
      expect(pushed.every((d) => d.replacedByAircraftId === undefined)).toBe(true)

      const second = createDb(':memory:')
      migrate(second.db, { migrationsFolder: 'drizzle' })
      // Occupy ids 1 and 2 so the replacement's id differs from the first device's.
      createAircraft(second.db, { registration: 'G-LOC1', icaoType: 'B738' })
      createAircraft(second.db, { registration: 'G-LOC2', icaoType: 'B738' })
      await runSync(second.db, server, SESSION, join(tempDir, 'second.db'))

      const rows = second.db.select().from(aircraft).all()
      const oldRow = rows.find((r) => r.registration === 'G-OLD1')
      const newRow = rows.find((r) => r.registration === 'G-NEW1')
      expect(oldRow?.replacedByAircraftId).toBe(newRow?.id)
      expect(newRow?.id).toBeGreaterThan(2)
    })

    it('links even when the replacement comes later in the same pull', async () => {
      server.seed('aircraft', {
        uuid: 'retired',
        updatedAt: '2099-01-01T00:00:00.000Z',
        data: JSON.stringify({
          registration: 'G-RET1',
          icaoType: 'A320',
          replacedByAircraftUuid: 'successor'
        })
      })
      server.seed('aircraft', {
        uuid: 'successor',
        updatedAt: '2099-01-02T00:00:00.000Z',
        data: JSON.stringify({ registration: 'G-SUC1', icaoType: 'A320' })
      })

      await runSync(db, server, SESSION, dbPath)

      const rows = db.select().from(aircraft).all()
      expect(rows.find((r) => r.uuid === 'retired')?.replacedByAircraftId).toBe(
        rows.find((r) => r.uuid === 'successor')?.id
      )
    })

    it('ignores a raw local id in a pulled row and a link to an aircraft that never arrives', async () => {
      const mine = createAircraft(db, { registration: 'G-MINE', icaoType: 'A320' })
      server.seed('aircraft', {
        uuid: 'forged',
        updatedAt: '2099-01-01T00:00:00.000Z',
        data: JSON.stringify({
          registration: 'G-FRG1',
          icaoType: 'A320',
          replacedByAircraftId: mine.id,
          replacedByAircraftUuid: 'nobody'
        })
      })

      await runSync(db, server, SESSION, dbPath)

      expect(
        db.select().from(aircraft).where(eq(aircraft.uuid, 'forged')).get()?.replacedByAircraftId
      ).toBeNull()
    })
  })

  describe('push batching', () => {
    const row = (n: number, size = 10): SyncRow => ({
      uuid: `u${n}`,
      updatedAt: '2026-09-04T10:00:00.000Z',
      data: 'x'.repeat(size)
    })

    it('splits rows into batches of at most 500', () => {
      const rows = Array.from({ length: MAX_PUSH_ROWS * 2 + 1 }, (_, i) => row(i))
      const { batches, oversize } = splitPushBatches(rows)
      expect(batches.map((b) => b.length)).toEqual([MAX_PUSH_ROWS, MAX_PUSH_ROWS, 1])
      expect(oversize).toEqual([])
    })

    it('starts a new batch before the request body would pass the byte cap', () => {
      const big = MAX_ROW_DATA_BYTES - 1
      const { batches } = splitPushBatches(Array.from({ length: 12 }, (_, i) => row(i, big)))
      expect(batches.length).toBeGreaterThan(1)
      for (const b of batches) {
        expect(b.reduce((sum, r) => sum + r.data.length, 0)).toBeLessThanOrEqual(20 * 1024 * 1024)
      }
      expect(batches.flat()).toHaveLength(12)
    })

    it('sets aside a row whose data is over the per-row limit instead of sending it', () => {
      const { batches, oversize } = splitPushBatches([row(1), row(2, MAX_ROW_DATA_BYTES + 1), row(3)])
      expect(oversize).toEqual(['u2'])
      expect(batches.flat().map((r) => r.uuid)).toEqual(['u1', 'u3'])
    })

    it('returns no batches for no rows', () => {
      expect(splitPushBatches([])).toEqual({ batches: [], oversize: [] })
    })

    it('runSync pushes a large first sync in several requests and counts every row', async () => {
      for (let i = 0; i < MAX_PUSH_ROWS + 5; i++) {
        createAircraft(db, { registration: `G-T${String(i).padStart(3, '0')}`, icaoType: 'A320' })
      }
      const sizes: number[] = []
      const original = server.syncPush.bind(server)
      server.syncPush = async (email, token, table, rows) => {
        sizes.push(rows.length)
        return original(email, token, table, rows)
      }

      const result = await runSync(db, server, SESSION, dbPath)

      expect(sizes).toEqual([MAX_PUSH_ROWS, 5])
      expect(result.tables.aircraft.pushed).toBe(MAX_PUSH_ROWS + 5)
    })
  })

  describe('the same registration created on two devices', () => {
    const remoteAircraft = (updatedAt: string, icaoType: string): SyncRow => ({
      uuid: 'other-device-uuid',
      updatedAt,
      data: JSON.stringify({ registration: 'G-ABCD', icaoType })
    })

    it('merges into the local aircraft instead of skipping it, and attaches its flights', async () => {
      const mine = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' })
      await runSync(db, server, SESSION, dbPath)
      server.seed('aircraft', remoteAircraft('2099-01-01T00:00:00.000Z', 'A321'))
      server.seed('flight', {
        uuid: 'remote-flight',
        updatedAt: '2099-01-01T00:00:00.000Z',
        data: JSON.stringify({ aircraftUuid: 'other-device-uuid', depIcao: 'EGLL', arrIcao: 'EGCC' })
      })

      const result = await runSync(db, server, SESSION, dbPath)

      expect(result.tables.aircraft.skipped).toEqual([])
      expect(result.tables.flight.skipped).toEqual([])
      const rows = db.select().from(aircraft).all()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ id: mine.id, icaoType: 'A321' })
      expect(db.select().from(flight).get()?.aircraftId).toBe(mine.id)
    })

    it('keeps merging on later syncs, and an older copy does not overwrite a newer local edit', async () => {
      const mine = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' })
      server.seed('aircraft', remoteAircraft('2000-01-01T00:00:00.000Z', 'B738'))
      await runSync(db, server, SESSION, dbPath)
      await runSync(db, server, SESSION, dbPath)

      const rows = db.select().from(aircraft).all()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ id: mine.id, icaoType: 'A320' })
    })
  })
})
