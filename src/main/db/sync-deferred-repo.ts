/**
 * Rows from a peer kept to try again (winglog-backend's docs/plans/security-audit-v2.md, step 23): a row refused only because its time is more
 * than a day ahead of this computer's clock. The cursor has already moved past it, so without this a computer whose clock is slow would pass a
 * real edit over for good. The apply that tries them again is `retryDeferredRows` (src/main/sync/deferred-rows.ts).
 */

import { and, asc, count, eq } from 'drizzle-orm'
import type { WingLogDb } from './client'
import { syncDeferredRow } from './schema'

/** The most rows kept for one peer: a peer whose rows are far ahead for good (a clock set years out) cannot fill the database. */
export const MAX_DEFERRED_ROWS_PER_PEER = 500

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
 * @returns False when the peer already has as many kept as it may, so the row was not kept.
 */
export function deferRow(db: WingLogDb, peer: string, table: string, row: DeferredRow): boolean {
  const key = and(
    eq(syncDeferredRow.peer, peer),
    eq(syncDeferredRow.tableName, table),
    eq(syncDeferredRow.uuid, row.uuid)
  )
  const isKept =
    db.select({ uuid: syncDeferredRow.uuid }).from(syncDeferredRow).where(key).get() !== undefined
  if (!isKept && countDeferredRows(db, peer) >= MAX_DEFERRED_ROWS_PER_PEER) return false
  db.delete(syncDeferredRow).where(key).run()
  db.insert(syncDeferredRow)
    .values({ peer, tableName: table, uuid: row.uuid, updatedAt: row.updatedAt, data: row.data })
    .run()
  return true
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
