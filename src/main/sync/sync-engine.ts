/**
 * Implements the pull-then-push protocol from flightdeck-backend/docs/plans/cloud-sync.md
 * against the local DB, table by table, in FK dependency order (aircraft, then flight,
 * then landing/flightInvoice — both reference flight). Talks to the backend only through
 * the SyncClient interface, not sync-client.ts directly, so this is unit-testable against
 * a mock (CLAUDE.md's "sits behind an interface, tested against a mock" pattern, already
 * used for SimConnectService).
 *
 * Each table's local rows are stored with a real integer id/FK for everything else in the
 * app to join on, but synced as an opaque {uuid, updatedAt, data} blob — the parent-table
 * reference inside `data` is the parent's *uuid*, translated to/from the local integer id
 * at the sync boundary only (aircraftUuid on a flight, flightUuid on a landing/invoice).
 */
import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  getAircraftIdByUuid,
  getAircraftUuidById,
  listAircraftForSync,
  upsertAircraftByUuid
} from '../db/aircraft-repo'
import type { WingLogDb } from '../db/client'
import { listFlightInvoicesForSync, upsertFlightInvoiceByUuid } from '../db/flight-invoice-repo'
import { getFlightIdByUuid, getFlightUuidById, listFlightsForSync, upsertFlightByUuid } from '../db/flight-repo'
import { listLandingsForSync, upsertLandingByUuid } from '../db/landing-repo'
import { getLastSyncedAt, setLastSyncedAt } from '../db/settings-repo'
import { SYNC_TABLES, type SyncRow, type SyncTable } from '../backend/sync-client'

export interface SyncClient {
  syncPull(email: string, token: string, table: SyncTable, since: string | null): Promise<SyncRow[]>
  syncPush(
    email: string,
    token: string,
    table: SyncTable,
    rows: SyncRow[]
  ): Promise<{ upserted: string[]; rejected: string[] }>
}

export interface SyncSession {
  email: string
  token: string
}

export interface SyncTableResult {
  pulled: number
  pushed: number
  /** uuids on the losing side of a last-write-wins comparison — logged to
   *  sync-conflicts.log, not silently dropped. Covers both directions: a push the server
   *  already had a newer updatedAt for, *and* a pulled row this device didn't apply
   *  because its own not-yet-pushed local edit was already the same age or newer. */
  rejected: string[]
  /** uuids that couldn't be applied at all — an unresolved parent reference, or malformed
   *  data. Also logged; distinct from `rejected` (a real conflict) since these are data
   *  problems, not a legitimate two-sided edit. */
  skipped: string[]
}

export interface SyncResult {
  syncedAt: string
  tables: Record<SyncTable, SyncTableResult>
}

function conflictLogPath(dbPath: string): string {
  return join(dirname(dbPath), 'sync-conflicts.log')
}

function logSyncEvent(dbPath: string, event: Record<string, unknown>): void {
  appendFileSync(conflictLogPath(dbPath), JSON.stringify({ loggedAt: new Date().toISOString(), ...event }) + '\n')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Cheap defensive parse (CLAUDE.md: "external data is data, never code, parse
 *  defensively") — this is server-relayed data this same app wrote, not a hostile third
 *  party, but it did cross a network boundary, so a malformed row degrades to "skipped"
 *  rather than throwing and aborting the whole table's sync. */
function parseRowData(json: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(json)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Shallow copy with the given keys removed — used instead of destructure-and-discard
 *  (`const { x: _x, ...rest } = obj`) so the deliberately-unused binding doesn't need a
 *  lint exemption. */
function omit<T extends Record<string, unknown>>(obj: T, keys: string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...obj }
  for (const key of keys) delete copy[key]
  return copy
}

/** Outcome of applying one pulled row locally. `applied: false` means the row was a
 *  legitimate last-write-wins loser against this device's own not-yet-pushed local edit
 *  (see upsertAircraftByUuid's comment) — distinct from `ok: false`, which means the row
 *  itself couldn't be applied at all (malformed data, unresolved parent reference). */
type ApplyResult = { ok: true; applied: boolean } | { ok: false; error: string }

// --- aircraft ---------------------------------------------------------------------------

function serializeAircraft(row: ReturnType<typeof listAircraftForSync>[number]): SyncRow {
  return {
    uuid: row.uuid as string,
    updatedAt: row.updatedAt as string,
    data: JSON.stringify(omit(row, ['id', 'uuid', 'updatedAt']))
  }
}

function applyAircraft(db: WingLogDb, row: SyncRow): ApplyResult {
  const data = parseRowData(row.data)
  if (!data || typeof data.registration !== 'string' || typeof data.icaoType !== 'string') {
    return { ok: false, error: 'malformed aircraft data' }
  }
  try {
    const applied = upsertAircraftByUuid(db, {
      ...data,
      uuid: row.uuid,
      updatedAt: row.updatedAt
    } as Parameters<typeof upsertAircraftByUuid>[1])
    return { ok: true, applied }
  } catch (err) {
    /* v8 ignore start -- better-sqlite3 always throws real Error instances; the String(err)
     * arm exists only for TypeScript's sake (a catch variable is typed `unknown`), not a
     * case real testing can trigger. */
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
    /* v8 ignore stop */
  }
}

// --- flight -----------------------------------------------------------------------------

function serializeFlight(db: WingLogDb, row: ReturnType<typeof listFlightsForSync>[number]): SyncRow | null {
  const aircraftUuid = getAircraftUuidById(db, row.aircraftId)
  if (!aircraftUuid) return null // parent aircraft has no uuid yet — shouldn't happen, see schema.ts
  return {
    uuid: row.uuid as string,
    updatedAt: row.updatedAt as string,
    data: JSON.stringify({ ...omit(row, ['id', 'uuid', 'updatedAt', 'aircraftId']), aircraftUuid })
  }
}

function applyFlight(db: WingLogDb, row: SyncRow): ApplyResult {
  const data = parseRowData(row.data)
  if (!data || typeof data.aircraftUuid !== 'string' || typeof data.depIcao !== 'string' || typeof data.arrIcao !== 'string') {
    return { ok: false, error: 'malformed flight data' }
  }
  const aircraftId = getAircraftIdByUuid(db, data.aircraftUuid)
  if (aircraftId === undefined) return { ok: false, error: `unknown aircraft ${data.aircraftUuid}` }
  try {
    const applied = upsertFlightByUuid(db, {
      ...omit(data, ['aircraftUuid']),
      aircraftId,
      uuid: row.uuid,
      updatedAt: row.updatedAt
    } as Parameters<typeof upsertFlightByUuid>[1])
    return { ok: true, applied }
  } catch (err) {
    /* v8 ignore start -- unlike aircraft (unique registration) or landing/flightInvoice
     * (required fields the malformed-data check above doesn't cover), the flight table has
     * no constraint a row already passing that check can still violate at insert. */
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
    /* v8 ignore stop */
  }
}

// --- landing ----------------------------------------------------------------------------

function serializeLanding(db: WingLogDb, row: ReturnType<typeof listLandingsForSync>[number]): SyncRow | null {
  const flightUuid = getFlightUuidById(db, row.flightId)
  if (!flightUuid) return null // parent flight not yet pulled/created here — retried next sync
  return {
    uuid: row.uuid as string,
    updatedAt: row.updatedAt as string,
    data: JSON.stringify({ ...omit(row, ['id', 'uuid', 'updatedAt', 'flightId']), flightUuid })
  }
}

function applyLanding(db: WingLogDb, row: SyncRow): ApplyResult {
  const data = parseRowData(row.data)
  if (!data || typeof data.flightUuid !== 'string') return { ok: false, error: 'malformed landing data' }
  const flightId = getFlightIdByUuid(db, data.flightUuid)
  if (flightId === undefined) return { ok: false, error: `unknown flight ${data.flightUuid}` }
  try {
    const applied = upsertLandingByUuid(db, {
      ...omit(data, ['flightUuid']),
      flightId,
      uuid: row.uuid,
      updatedAt: row.updatedAt
    } as Parameters<typeof upsertLandingByUuid>[1])
    return { ok: true, applied }
  } catch (err) {
    /* v8 ignore start -- see applyAircraft's identical catch for why the String(err) arm is
     * excluded. */
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
    /* v8 ignore stop */
  }
}

// --- flightInvoice ------------------------------------------------------------------------

function serializeFlightInvoice(
  db: WingLogDb,
  row: ReturnType<typeof listFlightInvoicesForSync>[number]
): SyncRow | null {
  const flightUuid = getFlightUuidById(db, row.flightId)
  if (!flightUuid) return null
  return {
    uuid: row.uuid as string,
    updatedAt: row.updatedAt as string,
    data: JSON.stringify({ ...omit(row, ['id', 'uuid', 'updatedAt', 'flightId']), flightUuid })
  }
}

function applyFlightInvoice(db: WingLogDb, row: SyncRow): ApplyResult {
  const data = parseRowData(row.data)
  if (!data || typeof data.flightUuid !== 'string' || typeof data.receiptId !== 'string') {
    return { ok: false, error: 'malformed flightInvoice data' }
  }
  const flightId = getFlightIdByUuid(db, data.flightUuid)
  if (flightId === undefined) return { ok: false, error: `unknown flight ${data.flightUuid}` }
  try {
    const applied = upsertFlightInvoiceByUuid(db, {
      ...omit(data, ['flightUuid']),
      flightId,
      uuid: row.uuid,
      updatedAt: row.updatedAt
    } as Parameters<typeof upsertFlightInvoiceByUuid>[1])
    return { ok: true, applied }
  } catch (err) {
    /* v8 ignore start -- see applyAircraft's identical catch for why the String(err) arm is
     * excluded. */
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
    /* v8 ignore stop */
  }
}

// --- dispatch -----------------------------------------------------------------------------

function listAndSerializeForPush(db: WingLogDb, table: SyncTable, since: string | null): SyncRow[] {
  switch (table) {
    case 'aircraft':
      return listAircraftForSync(db, since).map(serializeAircraft)
    case 'flight':
      return listFlightsForSync(db, since)
        .map((row) => serializeFlight(db, row))
        .filter((row): row is SyncRow => row !== null)
    case 'landing':
      return listLandingsForSync(db, since)
        .map((row) => serializeLanding(db, row))
        .filter((row): row is SyncRow => row !== null)
    case 'flightInvoice':
      return listFlightInvoicesForSync(db, since)
        .map((row) => serializeFlightInvoice(db, row))
        .filter((row): row is SyncRow => row !== null)
  }
}

function applyPulledRow(db: WingLogDb, table: SyncTable, row: SyncRow): ApplyResult {
  switch (table) {
    case 'aircraft':
      return applyAircraft(db, row)
    case 'flight':
      return applyFlight(db, row)
    case 'landing':
      return applyLanding(db, row)
    case 'flightInvoice':
      return applyFlightInvoice(db, row)
  }
}

/**
 * Runs one full pull-then-push cycle across all four synced tables, in dependency order.
 * `dbPath` is only used to place sync-conflicts.log next to the database file, per the
 * plan's "next to the DB, not a new table" — never opened directly here.
 */
export async function runSync(db: WingLogDb, client: SyncClient, session: SyncSession, dbPath: string): Promise<SyncResult> {
  // Captured once, before any table is touched — a local write that lands in the exact
  // window between this and a table's own read is simply picked up on the *next* sync
  // rather than this one; not lost, just delayed one cycle. Not worth engineering around
  // for a solo, low-frequency sync.
  const syncedAt = new Date().toISOString()
  const tables = {} as Record<SyncTable, SyncTableResult>

  for (const table of SYNC_TABLES) {
    const result: SyncTableResult = { pulled: 0, pushed: 0, rejected: [], skipped: [] }
    const since = getLastSyncedAt(db, table)

    const pulledRows = await client.syncPull(session.email, session.token, table, since)
    for (const row of pulledRows) {
      const outcome = applyPulledRow(db, table, row)
      if (!outcome.ok) {
        result.skipped.push(row.uuid)
        logSyncEvent(dbPath, { direction: 'pull', table, uuid: row.uuid, reason: outcome.error })
      } else if (outcome.applied) {
        result.pulled++
      } else {
        // This device's own not-yet-pushed local edit to the same uuid was already the
        // same age or newer — the incoming row lost the last-write-wins comparison, and
        // the *local* row (which will be considered for push below, per usual) is kept.
        result.rejected.push(row.uuid)
        logSyncEvent(dbPath, {
          direction: 'pull',
          table,
          uuid: row.uuid,
          reason: 'local already had a newer or equal updatedAt (last-write-wins)'
        })
      }
    }

    const toPush = listAndSerializeForPush(db, table, since)
    if (toPush.length > 0) {
      const { upserted, rejected } = await client.syncPush(session.email, session.token, table, toPush)
      result.pushed = upserted.length
      // Appended, not assigned — a pull-side rejection above must not be clobbered by an
      // empty push-side rejected list.
      result.rejected.push(...rejected)
      for (const uuid of rejected) {
        logSyncEvent(dbPath, { direction: 'push', table, uuid, reason: 'server already had a newer updatedAt (last-write-wins)' })
      }
    }

    // Only advance the cursor once both directions for this table have returned without
    // throwing — a mid-sync failure (network drop, 401) leaves it unmoved, so the retry
    // naturally re-covers whatever this attempt didn't finish.
    setLastSyncedAt(db, table, syncedAt)
    tables[table] = result
  }

  return { syncedAt, tables }
}
