import { readFileSync, rmSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAircraft } from '../db/aircraft-repo'
import { createDb, type FlightdeckDb } from '../db/client'
import { addInvoicesForFlight } from '../db/flight-invoice-repo'
import { createFlight } from '../db/flight-repo'
import { getLandingByFlight } from '../db/landing-repo'
import { getLastSyncedAt } from '../db/settings-repo'
import { aircraft, flight, flightInvoice } from '../db/schema'
import type { SyncRow, SyncTable } from '../backend/sync-client'
import { runSync, type SyncClient } from './sync-engine'

/** A high-fidelity fake of flightdeck-backend's real UserStore.push/pull semantics
 *  (last-write-wins on updatedAt, filter-by-since on pull) — see flightdeck-backend's
 *  src/user-store.ts, which this deliberately mirrors rather than reinventing. */
class FakeSyncServer implements SyncClient {
  private rows = new Map<SyncTable, Map<string, SyncRow>>()

  async syncPull(_email: string, _token: string, table: SyncTable, since: string | null): Promise<SyncRow[]> {
    const rows = [...(this.rows.get(table)?.values() ?? [])]
    return rows.filter((r) => since === null || r.updatedAt > since).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
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
  let db: FlightdeckDb
  let tempDir: string
  let dbPath: string
  let server: FakeSyncServer

  beforeEach(() => {
    const created = createDb(':memory:')
    migrate(created.db, { migrationsFolder: 'drizzle' })
    db = created.db
    tempDir = mkdtempSync(join(tmpdir(), 'flightdeck-sync-test-'))
    dbPath = join(tempDir, 'flightdeck.db')
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

  it('translates a flight-invoice\'s flightId to the parent flight\'s uuid on push, and back to a local id on pull', async () => {
    const createdAircraft = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' })
    const createdFlight = createFlight(db, { aircraftId: createdAircraft.id, depIcao: 'EGLL', arrIcao: 'EGKK' })
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
    const syncedUuid = db.select({ uuid: aircraft.uuid }).from(aircraft).where(eq(aircraft.id, created.id)).get()!.uuid as string

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

    db.update(aircraft).set({ registration: 'G-FROM-A', updatedAt: olderEdit }).where(eq(aircraft.uuid, syncedUuid)).run()
    dbB.db.update(aircraft).set({ registration: 'G-FROM-B', updatedAt: newerEdit }).where(eq(aircraft.uuid, syncedUuid)).run()

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
})
