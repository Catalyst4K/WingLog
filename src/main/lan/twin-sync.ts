/**
 * The host's side of a twin's sync (winglog-backend's docs/plans/multi-device.md, Part 4, and sync-cursors.md): the lookups only a twin may
 * ask, built on the sync engine's own serialize-a-row and apply-a-row, so a row means the same here as it does in the cloud, with last write
 * wins, tombstones and every row validated before it is stored. What a twin is given is found by this database's change counter, never by
 * a time, and a twin's own pushes are left out of what it is given.
 */

import type { WingLogDb } from '../db/client'
import { SYNC_TABLES, type SyncRow, type SyncTable } from '../backend/sync-client'
import { getFlightIdByUuid } from '../db/flight-repo'
import { highestChangeSeq, listChangesAfter, servedEpoch } from '../db/sync-change-repo'
import { countTrackPoints, listFlightUuidsWithTrack, listTrackPointRows } from '../db/track-point-repo'
import { applyPushedRows, MAX_PUSH_ROWS, MAX_ROW_DATA_BYTES, serializeChange } from '../sync/sync-engine'
import { localSyncVersion } from '../sync/sync-version'

/** The most one page of changed rows carries, in bytes and rows: a whole table in one answer could be tens of megabytes. */
export const PULL_PAGE_BYTES = 3_000_000
export const PULL_PAGE_ROWS = 200
/** The most work one page takes to build, milliseconds: a page that has taken this long ends there and the twin asks for the next, so the host's window is never held for long. */
export const PULL_PAGE_BUDGET_MS = 40

/** One page of a table's changed rows, the counter to ask from next, whether there is a further page, and what tells a twin this database's counter went back. */
export interface PullPage {
  rows: SyncRow[]
  cursor: number
  more: boolean
  /** The highest change number this database has given, in any table: a twin that has seen past it starts again (audit M8). */
  head: number
  /** This database's sync epoch: a twin holding another starts again (review of M8). */
  epoch: string
}

/** What a twin knows of this database's counter, as it sent it with a pull; an older twin sends nothing. */
interface KnownByTwin {
  seen: number | null
  epoch: string | null
}

/** Longest text taken for a uuid or a time. */
const MAX_KEY_CHARS = 64

/**
 * @param deviceId A twin's device id.
 * @returns What its pushes are marked with, so they are not sent back to it: the same text on the way in and the way out.
 */
export function twinOrigin(deviceId: number): string {
  return `twin:${deviceId}`
}

/**
 * @param value A table name from a twin.
 * @returns The table.
 * @throws When it is not one of the synced tables.
 */
function tableArg(value: unknown): SyncTable {
  const table = SYNC_TABLES.find((name) => name === value)
  if (!table) throw new Error('Unknown table')
  return table
}

/**
 * @param value A cursor from a twin: the `cursor` of the last page it was given.
 * @returns The counter, or null for "every row".
 * @throws When it is neither.
 */
function cursorArg(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid cursor')
  return value
}

/**
 * @param value What a twin knows of this database's counter: `{ seen, epoch }`, or nothing from an older twin.
 * @returns It, checked.
 * @throws When it is there but not that shape.
 */
function knownArg(value: unknown): KnownByTwin {
  if (value === undefined || value === null) return { seen: null, epoch: null }
  const record = typeof value === 'object' ? (value as Record<string, unknown>) : null
  const epoch = record?.epoch ?? null
  if (!record || (epoch !== null && (typeof epoch !== 'string' || epoch.length > MAX_KEY_CHARS))) {
    throw new Error('Invalid counter')
  }
  return { seen: cursorArg(record.seen), epoch }
}

/**
 * @param value The rows a twin pushed.
 * @returns The rows, each checked for its shape and size (what is in `data` is checked as each is applied).
 * @throws When there are too many, or one is malformed or too large.
 */
function rowsArg(value: unknown): SyncRow[] {
  if (!Array.isArray(value) || value.length > MAX_PUSH_ROWS) throw new Error('Invalid rows')
  return value.map((row: unknown) => {
    const record = typeof row === 'object' && row !== null ? (row as Record<string, unknown>) : null
    if (
      !record ||
      typeof record.uuid !== 'string' ||
      typeof record.updatedAt !== 'string' ||
      typeof record.data !== 'string' ||
      record.uuid.length === 0 ||
      record.uuid.length > MAX_KEY_CHARS ||
      record.updatedAt.length > MAX_KEY_CHARS ||
      Buffer.byteLength(record.data) > MAX_ROW_DATA_BYTES
    ) {
      throw new Error('Invalid row')
    }
    return { uuid: record.uuid, updatedAt: record.updatedAt, data: record.data }
  })
}

/**
 * One page of a table's changes after the twin's cursor, in the order they happened, leaving out what the twin itself sent. The cursor moves
 * past every change looked at, sent or not, so a twin's own rows (or a row that can't be sent yet) never hold up the ones behind them.
 *
 * @param db The database.
 * @param table The table.
 * @param cursor The `cursor` of the last page this twin was given for the table, or null for everything.
 * @param deviceId The asking twin.
 * @param known What the twin knows of this database's counter: a number it has seen past the head here, while it holds this database's epoch,
 *   means the counter went back, and the epoch is changed so every twin finds out.
 * @returns The page, the cursor to ask from next, whether there is more, this database's highest change number (`head`) and its epoch.
 */
export function pullChanges(
  db: WingLogDb,
  table: SyncTable,
  cursor: number | null,
  deviceId: number,
  known: KnownByTwin = { seen: null, epoch: null }
): PullPage {
  const head = highestChangeSeq(db)
  const epoch = servedEpoch(db, Math.max(cursor ?? 0, known.seen ?? 0), known.epoch)
  const from = cursor ?? 0
  const found = listChangesAfter(db, table, from, PULL_PAGE_ROWS + 1)
  const looked = found.slice(0, PULL_PAGE_ROWS)
  const own = twinOrigin(deviceId)
  const rows: SyncRow[] = []
  let last = from
  let bytes = 0
  let more = found.length > PULL_PAGE_ROWS
  const started = performance.now()
  for (const change of looked) {
    if (rows.length > 0 && performance.now() - started > PULL_PAGE_BUDGET_MS) {
      more = true
      break
    }
    if (change.origin !== own) {
      const row = serializeChange(db, table, change.uuid)
      if (row) {
        const size = Buffer.byteLength(row.data) + row.uuid.length + row.updatedAt.length
        if (rows.length > 0 && bytes + size > PULL_PAGE_BYTES) {
          more = true
          break
        }
        rows.push(row)
        bytes += size
      }
    }
    last = change.seq
  }
  return { rows, cursor: last, more, head, epoch }
}

/** Track points in one answer: a point is about 200 bytes, so a page stays well under what a twin takes in one message. */
export const TRACK_PAGE_ROWS = 2000

/** One page of a flight's recorded track, and where the next begins (null at the end). */
export interface TrackPage {
  points: Record<string, unknown>[]
  next: number | null
}

/**
 * @param db The database.
 * @param uuid A flight's uuid.
 * @param offset How many points the twin already has.
 * @returns The next page of the flight's points, or an empty one for a flight this computer does not have.
 */
export function trackPointsPage(db: WingLogDb, uuid: string, offset: number): TrackPage {
  const flightId = getFlightIdByUuid(db, uuid)
  if (flightId === undefined) return { points: [], next: null }
  const points = listTrackPointRows(db, flightId, offset, TRACK_PAGE_ROWS)
  const end = offset + points.length
  return { points, next: end < countTrackPoints(db, flightId) ? end : null }
}

/**
 * @param value A uuid from a twin.
 * @returns The uuid.
 * @throws When it is not a short text.
 */
function uuidArg(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_KEY_CHARS)
    throw new Error('Invalid flight')
  return value
}

/**
 * @param value An offset from a twin.
 * @returns The offset.
 * @throws When it is not a whole number from zero.
 */
function offsetArg(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid offset')
  return value
}

/**
 * @param db The database.
 * @returns The lookups a twin may ask that don't need to know which twin it is: `sync.version`, `sync.trackedFlights` (which flights have a track) and `sync.trackPoints`.
 */
export function twinSyncQueries(db: WingLogDb): Record<string, (...args: unknown[]) => unknown> {
  return {
    'sync.version': () => localSyncVersion(db),
    'sync.trackedFlights': () => listFlightUuidsWithTrack(db),
    'sync.trackPoints': (uuid, offset) => trackPointsPage(db, uuidArg(uuid), offsetArg(offset))
  }
}

/**
 * @param db The database.
 * @param dbPath The database file's path, where conflicts are logged next to it.
 * @param onApplied Called when a push stored rows, so the window on this computer can read them (it did not make the change).
 * @returns The lookups a twin may ask that need its device id: `sync.pull` and `sync.push`.
 */
export function twinSyncDeviceQueries(
  db: WingLogDb,
  dbPath: string,
  onApplied: () => void = () => {}
): Record<string, (deviceId: number, ...args: unknown[]) => unknown> {
  return {
    'sync.pull': (deviceId, table, cursor, known) =>
      pullChanges(db, tableArg(table), cursorArg(cursor), deviceId, knownArg(known)),
    'sync.push': (deviceId, table, rows) => {
      // Checked now, so a bad request is refused at once; the rows are then applied a few at a time.
      const checkedTable = tableArg(table)
      const checkedRows = rowsArg(rows)
      return applyPushedRows(db, checkedTable, checkedRows, dbPath, twinOrigin(deviceId)).then((result) => {
        if (result.upserted.length > 0) onApplied()
        // The counter after the push, so the twin knows what it has seen before it pulls again (review of M8).
        return { ...result, head: highestChangeSeq(db) }
      })
    }
  }
}
