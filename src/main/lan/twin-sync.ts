/**
 * The host's side of a twin's sync (winglog-backend's docs/plans/multi-device.md, Part 4): two lookups only a twin may ask, built on the
 * cloud sync engine's own list-for-push and apply-a-row, so a row means the same here as it does in the cloud, with last write wins,
 * tombstones and every row validated before it is stored.
 */

import type { WingLogDb } from '../db/client'
import { SYNC_TABLES, type SyncRow, type SyncTable } from '../backend/sync-client'
import {
  applyPushedRows,
  listAndSerializeForPush,
  MAX_PUSH_ROWS,
  MAX_ROW_DATA_BYTES
} from '../sync/sync-engine'

/** The most one page of changed rows carries, in bytes and rows: a whole table in one answer could be tens of megabytes. */
export const PULL_PAGE_BYTES = 3_000_000
export const PULL_PAGE_ROWS = 200

/** Where a page ended, so the next one starts after it. */
export interface PullCursor {
  updatedAt: string
  uuid: string
}

/** One page of a table's changed rows, and where the next begins (null at the end). */
export interface PullPage {
  rows: SyncRow[]
  next: PullCursor | null
}

/** Longest text taken for a uuid or a time. */
const MAX_KEY_CHARS = 64

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
 * @param value A cursor time from a twin.
 * @returns The time, or null for "every row".
 * @throws When it is neither.
 */
function sinceArg(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || value.length > MAX_KEY_CHARS) throw new Error('Invalid cursor')
  return value
}

/**
 * @param value Where the last page ended, from a twin.
 * @returns The place, or null for the start.
 * @throws When it is neither.
 */
function afterArg(value: unknown): PullCursor | null {
  if (value === null || value === undefined) return null
  const record = typeof value === 'object' ? (value as Record<string, unknown>) : null
  if (
    !record ||
    typeof record.updatedAt !== 'string' ||
    typeof record.uuid !== 'string' ||
    record.updatedAt.length > MAX_KEY_CHARS ||
    record.uuid.length > MAX_KEY_CHARS
  ) {
    throw new Error('Invalid cursor')
  }
  return { updatedAt: record.updatedAt, uuid: record.uuid }
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
 * @param a A row.
 * @param b Another row.
 * @returns Their order: by when they changed, then by uuid, so a page boundary is exact.
 */
function byChange(a: PullCursor, b: PullCursor): number {
  return a.updatedAt === b.updatedAt ? a.uuid.localeCompare(b.uuid) : a.updatedAt.localeCompare(b.updatedAt)
}

/**
 * One page of the rows of a table that changed after a cursor, in the order they changed.
 *
 * @param db The database.
 * @param table The table.
 * @param since The twin's cursor for this table, or null for every row.
 * @param after Where the last page ended, or null for the first.
 * @returns The page, and where the next begins.
 */
export function pullPage(
  db: WingLogDb,
  table: SyncTable,
  since: string | null,
  after: PullCursor | null
): PullPage {
  const all = listAndSerializeForPush(db, table, since).sort(byChange)
  const start = after ? all.findIndex((row) => byChange(row, after) > 0) : 0
  if (start < 0) return { rows: [], next: null }
  const rows: SyncRow[] = []
  let bytes = 0
  for (const row of all.slice(start)) {
    const size = Buffer.byteLength(row.data) + row.uuid.length + row.updatedAt.length
    if (rows.length > 0 && (rows.length >= PULL_PAGE_ROWS || bytes + size > PULL_PAGE_BYTES)) break
    rows.push(row)
    bytes += size
  }
  const last = rows.at(-1)
  const more = start + rows.length < all.length
  return { rows, next: more && last ? { updatedAt: last.updatedAt, uuid: last.uuid } : null }
}

/**
 * @param db The database.
 * @param dbPath The database file's path, where conflicts are logged next to it.
 * @returns The lookups a twin may ask: `sync.pull` and `sync.push`.
 */
export function twinSyncQueries(
  db: WingLogDb,
  dbPath: string
): Record<string, (...args: unknown[]) => unknown> {
  return {
    'sync.pull': (table, since, after) => pullPage(db, tableArg(table), sinceArg(since), afterArg(after)),
    'sync.push': (table, rows) => applyPushedRows(db, tableArg(table), rowsArg(rows), dbPath)
  }
}
