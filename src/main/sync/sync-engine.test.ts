import { readFileSync, rmSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
