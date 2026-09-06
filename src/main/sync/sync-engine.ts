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
import type { FlightdeckDb } from '../db/client'
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
  /** uuids the server already had a newer updatedAt for (last-write-wins loser) — logged
   *  to sync-conflicts.log, not silently dropped. */
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

// --- aircraft ---------------------------------------------------------------------------

function serializeAircraft(row: ReturnType<typeof listAircraftForSync>[number]): SyncRow {
  return {
    uuid: row.uuid as string,
    updatedAt: row.updatedAt as string,
    data: JSON.stringify(omit(row, ['id', 'uuid', 'updatedAt']))
  }
}

function applyAircraft(db: FlightdeckDb, row: SyncRow): { ok: true } | { ok: false; error: string } {
  const data = parseRowData(row.data)
  if (!data || typeof data.registration !== 'string' || typeof data.icaoType !== 'string') {
    return { ok: false, error: 'malformed aircraft data' }
  }
  try {
    upsertAircraftByUuid(db, { ...data, uuid: row.uuid, updatedAt: row.updatedAt } as Parameters<typeof upsertAircraftByUuid>[1])
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// --- flight -----------------------------------------------------------------------------

function serializeFlight(db: FlightdeckDb, row: ReturnType<typeof listFlightsForSync>[number]): SyncRow | null {
  const aircraftUuid = getAircraftUuidById(db, row.aircraftId)
  if (!aircraftUuid) return null // parent aircraft has no uuid yet — shouldn't happen, see schema.ts
  return {
    uuid: row.uuid as string,
    updatedAt: row.updatedAt as string,
    data: JSON.stringify({ ...omit(row, ['id', 'uuid', 'updatedAt', 'aircraftId']), aircraftUuid })
  }
}

function applyFlight(db: FlightdeckDb, row: SyncRow): { ok: true } | { ok: false; error: string } {
  const data = parseRowData(row.data)
  if (!data || typeof data.aircraftUuid !== 'string' || typeof data.depIcao !== 'string' || typeof data.arrIcao !== 'string') {
    return { ok: false, error: 'malformed flight data' }
  }
  const aircraftId = getAircraftIdByUuid(db, data.aircraftUuid)
  if (aircraftId === undefined) return { ok: false, error: `unknown aircraft ${data.aircraftUuid}` }
  try {
    upsertFlightByUuid(db, {
      ...omit(data, ['aircraftUuid']),
      aircraftId,
      uuid: row.uuid,
      updatedAt: row.updatedAt
    } as Parameters<typeof upsertFlightByUuid>[1])
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// --- landing ----------------------------------------------------------------------------

function serializeLanding(db: FlightdeckDb, row: ReturnType<typeof listLandingsForSync>[number]): SyncRow | null {
  const flightUuid = getFlightUuidById(db, row.flightId)
  if (!flightUuid) return null // parent flight not yet pulled/created here — retried next sync
  return {
    uuid: row.uuid as string,
    updatedAt: row.updatedAt as string,
    data: JSON.stringify({ ...omit(row, ['id', 'uuid', 'updatedAt', 'flightId']), flightUuid })
  }
}

function applyLanding(db: FlightdeckDb, row: SyncRow): { ok: true } | { ok: false; error: string } {
  const data = parseRowData(row.data)
  if (!data || typeof data.flightUuid !== 'string') return { ok: false, error: 'malformed landing data' }
  const flightId = getFlightIdByUuid(db, data.flightUuid)
  if (flightId === undefined) return { ok: false, error: `unknown flight ${data.flightUuid}` }
  try {
    upsertLandingByUuid(db, {
      ...omit(data, ['flightUuid']),
      flightId,
      uuid: row.uuid,
      updatedAt: row.updatedAt
    } as Parameters<typeof upsertLandingByUuid>[1])
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// --- flightInvoice ------------------------------------------------------------------------

function serializeFlightInvoice(
  db: FlightdeckDb,
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

function applyFlightInvoice(db: FlightdeckDb, row: SyncRow): { ok: true } | { ok: false; error: string } {
  const data = parseRowData(row.data)
  if (!data || typeof data.flightUuid !== 'string' || typeof data.receiptId !== 'string') {
    return { ok: false, error: 'malformed flightInvoice data' }
  }
  const flightId = getFlightIdByUuid(db, data.flightUuid)
  if (flightId === undefined) return { ok: false, error: `unknown flight ${data.flightUuid}` }
  try {
    upsertFlightInvoiceByUuid(db, {
      ...omit(data, ['flightUuid']),
      flightId,
      uuid: row.uuid,
      updatedAt: row.updatedAt
    } as Parameters<typeof upsertFlightInvoiceByUuid>[1])
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// --- dispatch -----------------------------------------------------------------------------

function listAndSerializeForPush(db: FlightdeckDb, table: SyncTable, since: string | null): SyncRow[] {
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

function applyPulledRow(db: FlightdeckDb, table: SyncTable, row: SyncRow): { ok: true } | { ok: false; error: string } {
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
export async function runSync(db: FlightdeckDb, client: SyncClient, session: SyncSession, dbPath: string): Promise<SyncResult> {
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
      const applied = applyPulledRow(db, table, row)
      if (applied.ok) {
        result.pulled++
      } else {
        result.skipped.push(row.uuid)
        logSyncEvent(dbPath, { direction: 'pull', table, uuid: row.uuid, reason: applied.error })
      }
    }

    const toPush = listAndSerializeForPush(db, table, since)
    if (toPush.length > 0) {
      const { upserted, rejected } = await client.syncPush(session.email, session.token, table, toPush)
      result.pushed = upserted.length
      result.rejected = rejected
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
