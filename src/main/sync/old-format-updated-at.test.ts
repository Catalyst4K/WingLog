/**
 * Investigation: rows whose `updated_at` is in SQLite's `datetime('now')` form (`2026-09-01 16:50:31`: a space, no `T`, no `Z`).
 * On the sim PC's real database there are 177 flights and 6 invoices like that, all from 2026-09-01..04, copied from `created_at` by migration
 * 0010's backfill (`updated_at = created_at`, and `created_at` defaults to `current_timestamp`).
 * The receivers (`checkedPeerTime`, the Worker's `isIsoTimestamp`) accept only `toISOString`'s shape, so these rows are refused for good.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAircraft } from '../db/aircraft-repo'
import { createDb, type WingLogDb } from '../db/client'
import { createFlight } from '../db/flight-repo'
import { flight, flightInvoice } from '../db/schema'
import { shouldApplyPulledRow } from '../db/sync-rows'
import { pullChanges } from '../lan/twin-sync'
import type { SyncRow, SyncTable } from '../backend/sync-client'
import { runCursorSync, type PagedSyncClient, type PulledPage } from './cursor-sync'

const OLD_FORM = '2026-09-01 16:50:31'
const SESSION = { email: 'callum@example.com', token: 'test-token' }

/** Copy of winglog-backend `src/http.ts` ISO_TIMESTAMP (line 35), which `isIsoTimestamp` -> `checkedRow` in `user-store.ts` uses on every push. */
const WORKER_ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/

function newDb(): WingLogDb {
  const { db } = createDb(':memory:')
  migrate(db, { migrationsFolder: 'drizzle' })
  return db
}

/** A PC database holding one aircraft, one flight and one invoice, the flight and invoice stamped as migration 0010 left the early ones. */
function pcWithOldFormatRows(): WingLogDb {
  const db = newDb()
  const plane = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' })
  const created = createFlight(db, { aircraftId: plane.id, depIcao: 'EGLL', arrIcao: 'EGCC' })
  db.insert(flightInvoice)
    .values({
      flightId: created.id,
      serviceGroup: 'fuel',
      receiptId: 'R-1',
      issuedUtc: '2026-09-01T16:00:00.000Z',
      icao: 'EGLL',
      tail: 'G-ABCD',
      sourceHtmlPath: 'receipt.html',
      receiptJson: '{}',
      uuid: '00000000-0000-4000-8000-0000000000aa',
      updatedAt: OLD_FORM
    })
    .run()
  // Written as SQL, as the real rows were: the repo's own writes would give an ISO time.
  db.update(flight).set({ updatedAt: OLD_FORM }).where(eq(flight.id, created.id)).run()
  return db
}

describe('rows with a datetime("now")-form updated_at', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'winglog-oldfmt-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('cause: migration 0010 backfills updated_at from created_at, which defaults to current_timestamp, so it is not an ISO time', () => {
    const sqlite = new Database(':memory:')
    sqlite.exec(
      'CREATE TABLE flight (id integer primary key, created_at text DEFAULT (current_timestamp) NOT NULL)'
    )
    sqlite.exec('INSERT INTO flight DEFAULT VALUES')
    sqlite.exec('ALTER TABLE flight ADD updated_at text')
    // The statement from drizzle/0010_aspiring_george_stacy.sql (the uuid half left out).
    sqlite.exec('UPDATE flight SET updated_at = created_at WHERE updated_at IS NULL')
    const stored = (sqlite.prepare('SELECT updated_at FROM flight').get() as { updated_at: string })
      .updated_at
    expect(stored).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    // ...and what the upgrade left it as is not a time any receiver takes.
    expect(WORKER_ISO_TIMESTAMP.test(stored)).toBe(false)
    sqlite.close()
  })

  it('the host serves such a row as the same UTC time in ISO form (the safety net on send)', () => {
    const pc = pcWithOldFormatRows()
    const page = pullChanges(pc, 'flight', null, 99)
    expect(page.rows.map((row) => row.updatedAt)).toEqual(['2026-09-01T16:50:31.000Z'])
  })

  it('a twin (or a second computer) pairing with the host gets every flight, including the old-format one', async () => {
    const pc = pcWithOldFormatRows()
    const hostAsPeer: PagedSyncClient = {
      async syncPullPage(_e, _t, table: SyncTable, cursor, known): Promise<PulledPage> {
        return pullChanges(pc, table, cursor, 99, known && { ...known, selfEpoch: null })
      },
      async syncPush() {
        return { upserted: [], rejected: [] }
      }
    }
    const twin = newDb()
    const result = await runCursorSync(twin, hostAsPeer, SESSION, join(dir, 'twin.db'), 'host')
    expect(result.tables.flight.skipped).toEqual([])
    expect(twin.select().from(flight).all()).toHaveLength(1)
    expect(twin.select().from(flightInvoice).all()).toHaveLength(1)
  })

  it('a fresh cloud account receives every flight the PC pushes, as the Worker validates a push', async () => {
    const pc = pcWithOldFormatRows()
    const stored = new Map<string, SyncRow>()
    const worker: PagedSyncClient = {
      async syncPullPage(): Promise<PulledPage> {
        return { rows: [], cursor: 0, more: false }
      },
      async syncPush(_e, _t, table, rows) {
        const upserted: string[] = []
        const refused: string[] = []
        for (const row of rows) {
          // user-store.ts checkedRow: refused when updatedAt is not in ISO_TIMESTAMP's shape.
          if (!WORKER_ISO_TIMESTAMP.test(row.updatedAt)) refused.push(row.uuid)
          else {
            stored.set(`${table}:${row.uuid}`, row)
            upserted.push(row.uuid)
          }
        }
        return { upserted, rejected: [], refused }
      }
    }
    const result = await runCursorSync(pc, worker, SESSION, join(dir, 'pc.db'), 'cloud')
    expect(result.tables.flight.skipped).toEqual([])
    expect(result.tables.flightInvoice.skipped).toEqual([])
    expect([...stored.keys()].filter((key) => key.startsWith('flight:'))).toHaveLength(1)
  })

  it('control: the same twin pull succeeds once the old form is written as an ISO time on the way (the sim PC database is UTC), so the form is the cause', async () => {
    const pc = pcWithOldFormatRows()
    const toIso = (value: string): string =>
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
        ? new Date(`${value.replace(' ', 'T')}Z`).toISOString()
        : value
    const hostAsPeer: PagedSyncClient = {
      async syncPullPage(_e, _t, table: SyncTable, cursor, known): Promise<PulledPage> {
        const page = pullChanges(pc, table, cursor, 99, known && { ...known, selfEpoch: null })
        return { ...page, rows: page.rows.map((row) => ({ ...row, updatedAt: toIso(row.updatedAt) })) }
      },
      async syncPush() {
        return { upserted: [], rejected: [] }
      }
    }
    const twin = newDb()
    const result = await runCursorSync(twin, hostAsPeer, SESSION, join(dir, 'twin.db'), 'host')
    expect(result.tables.flight.skipped).toEqual([])
    expect(twin.select().from(flight).all()).toHaveLength(1)
    expect(twin.select().from(flightInvoice).all()).toHaveLength(1)
  })

  it('latent: last-write-wins as text lets an older ISO time beat a newer old-form one on the same date (a space sorts before T)', () => {
    // The local row was last changed at 16:50:31; the pulled one is from 10:00 the same day, so it is older and must lose.
    expect(shouldApplyPulledRow({ uuid: 'u', updatedAt: OLD_FORM }, '2026-09-01T10:00:00.000Z')).toBe(false)
  })
})
