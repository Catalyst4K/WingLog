/**
 * Rows from a peer kept to try again (winglog-backend's docs/plans/security-audit-v2.md, step 23): a row refused only because its time is more
 * than a day ahead of this computer's clock. The cursor has already moved past it, so without this a computer whose clock is slow would pass a
 * real edit over for good. The apply that tries them again is `retryDeferredRows` (src/main/sync/deferred-rows.ts).
 */

import { and, asc, count, eq, sql } from 'drizzle-orm'
import type { WingLogDb } from './client'
import { syncDeferredRow } from './schema'

/** The most rows kept for one peer: a peer whose rows are far ahead for good (a clock set years out) cannot fill the database. */
export const MAX_DEFERRED_ROWS_PER_PEER = 500

/**
 * The most data kept for one peer, in bytes: every kept row is read and tried again at each sync, and one can be up to 1.9 MB (the sync's
 * row limit), so 500 rows could be about a gigabyte. 20 MB is eleven of the largest rows, or some thousands of ordinary ones (a flight row is a few
 * kilobytes), so for ordinary rows the row limit is reached first, and one sync's retry stays a small read.
 */
export const MAX_DEFERRED_BYTES_PER_PEER = 20 * 1024 * 1024

/**
 * How far ahead of this computer's clock a kept row's time may be, in milliseconds. A clock a day or two slow is the case being kept for
 * (a row more than a day ahead is refused, MAX_PEER_TIME_AHEAD_MS); a row a month ahead is a peer with the wrong date, and would sit here until
 * the clock reached it. The limit also bounds how long a row is kept: it is tried again at each sync and applied once within a day of the
 * clock, so on a clock that is running none stays longer than 29 days.
 */
export const MAX_DEFERRED_TIME_AHEAD_MS = 30 * 24 * 60 * 60 * 1000

/**
 * @param updatedAt A kept row's time.
 * @param now This computer's clock, in milliseconds.
 * @returns True when the time is more than the most a kept row may be ahead of the clock. A time that is not one is not (it was checked before
 *   the row was kept).
 */
export function isTooFarAhead(updatedAt: string, now: number): boolean {
  const time = Date.parse(updatedAt)
  return Number.isFinite(time) && time > now + MAX_DEFERRED_TIME_AHEAD_MS
}

/** A row's data in bytes, for the one that holds it. */
const dataBytes = sql<number>`length(cast(${syncDeferredRow.data} as blob))`

/** A kept row: the same shape it came in. */
export interface DeferredRow {
  uuid: string
  updatedAt: string
  data: string
}

/**
 * Keeps a row to try again, in place of any kept before for the same row.
 *
 * @param db The database.
 * @param peer Who the row came from.
 * @param table The synced table.
 * @param row The row as it came.
 * @param now This computer's clock, in milliseconds.
 * @returns False when the row was not kept: its time is too far ahead, or the peer already has as many rows or as many bytes kept as it may.
 *   A row kept before is left as it was.
 */
export function deferRow(
  db: WingLogDb,
  peer: string,
  table: string,
  row: DeferredRow,
  now: number = Date.now()
): boolean {
  if (isTooFarAhead(row.updatedAt, now)) return false
  const key = and(
    eq(syncDeferredRow.peer, peer),
    eq(syncDeferredRow.tableName, table),
    eq(syncDeferredRow.uuid, row.uuid)
  )
  const kept = db.select({ bytes: dataBytes }).from(syncDeferredRow).where(key).get()
  if (kept === undefined && countDeferredRows(db, peer) >= MAX_DEFERRED_ROWS_PER_PEER) return false
  // A row kept in place of one before takes the old one's room.
  const others = countDeferredBytes(db, peer) - (kept?.bytes ?? 0)
  if (others + Buffer.byteLength(row.data) > MAX_DEFERRED_BYTES_PER_PEER) return false
  db.delete(syncDeferredRow).where(key).run()
  db.insert(syncDeferredRow)
    .values({ peer, tableName: table, uuid: row.uuid, updatedAt: row.updatedAt, data: row.data })
    .run()
  return true
}

/**
 * @param db The database.
 * @param peer The peer.
 * @returns How many bytes of row data are kept for it.
 */
export function countDeferredBytes(db: WingLogDb, peer: string): number {
  const total = sql<number>`coalesce(sum(${dataBytes}), 0)`
  return (
    db.select({ bytes: total }).from(syncDeferredRow).where(eq(syncDeferredRow.peer, peer)).get()?.bytes ?? 0
  )
}

/**
 * @param db The database.
 * @param peer The peer.
 * @returns How many rows are kept for it.
 */
export function countDeferredRows(db: WingLogDb, peer: string): number {
  return db.select({ n: count() }).from(syncDeferredRow).where(eq(syncDeferredRow.peer, peer)).get()?.n ?? 0
}

/**
 * @param db The database.
 * @param peer The peer.
 * @param table The synced table.
 * @returns The rows kept for that peer and table, oldest time first.
 */
export function listDeferredRows(db: WingLogDb, peer: string, table: string): DeferredRow[] {
  return db
    .select({ uuid: syncDeferredRow.uuid, updatedAt: syncDeferredRow.updatedAt, data: syncDeferredRow.data })
    .from(syncDeferredRow)
    .where(and(eq(syncDeferredRow.peer, peer), eq(syncDeferredRow.tableName, table)))
    .orderBy(asc(syncDeferredRow.updatedAt))
    .all()
}

/**
 * @param db The database.
 * @param peer The peer.
 * @param table The synced table.
 * @param uuid The kept row's uuid.
 */
export function dropDeferredRow(db: WingLogDb, peer: string, table: string, uuid: string): void {
  db.delete(syncDeferredRow)
    .where(
      and(
        eq(syncDeferredRow.peer, peer),
        eq(syncDeferredRow.tableName, table),
        eq(syncDeferredRow.uuid, uuid)
      )
    )
    .run()
}

/**
 * Forgets every row kept for a peer: once it is started again, a full pull brings them anew.
 *
 * @param db The database.
 * @param peer The peer.
 */
export function clearDeferredRows(db: WingLogDb, peer: string): void {
  db.delete(syncDeferredRow).where(eq(syncDeferredRow.peer, peer)).run()
}
