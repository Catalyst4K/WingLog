/**
 * Reading the change counter and keeping each peer's cursors (winglog-backend docs/plans/sync-cursors.md). A cursor is a counter kept by
 * the side that serves the rows, never a time:
 * - `pullCursor:<peer>:<table>` is the peer's own counter, as the peer reported it;
 * - `pushCursor:<peer>:<table>` is this database's `sync_change.seq`, up to which rows have been sent to that peer.
 * The peer is `cloud`, or on a twin `host`, or on the sim PC `twin:<device id>`.
 */

import { and, asc, eq, gt, like, or } from 'drizzle-orm'
import type { WingLogDb } from './client'
import { aircraft, appSetting, flight, flightInvoice, landing, syncChange } from './schema'
import { getSetting, setSetting } from './settings-repo'

/** A counted change: which row, and where it came from (null: changed here). */
export interface Change {
  seq: number
  uuid: string
  origin: string | null
}

const pullKey = (peer: string, table: string): string => `pullCursor:${peer}:${table}`
const pushKey = (peer: string, table: string): string => `pushCursor:${peer}:${table}`

/**
 * @param value A stored cursor.
 * @returns The whole number it holds, or null when there is none or it is not one.
 */
function parseCursor(value: string | undefined): number | null {
  if (value === undefined) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

/**
 * Records that a row was applied from a peer, so it is not sent back to that peer. A change made here afterwards counts again with no origin
 * (the trigger replaces the entry).
 *
 * @param db The database.
 * @param table The synced table.
 * @param uuid The local uuid the row was written under (the one its alias points to, when it was merged into a row already here).
 * @param origin The peer it came from.
 */
export function markOrigin(db: WingLogDb, table: string, uuid: string, origin: string): void {
  db.update(syncChange)
    .set({ origin })
    .where(and(eq(syncChange.tableName, table), eq(syncChange.uuid, uuid)))
    .run()
}

/**
 * @param db The database.
 * @param table The synced table.
 * @param afterSeq Only changes numbered above this.
 * @param limit The most to return.
 * @returns The counted changes in the order they happened.
 */
export function listChangesAfter(db: WingLogDb, table: string, afterSeq: number, limit: number): Change[] {
  return db
    .select()
    .from(syncChange)
    .where(and(eq(syncChange.tableName, table), gt(syncChange.seq, afterSeq)))
    .orderBy(asc(syncChange.seq))
    .limit(limit)
    .all()
}

/**
 * @param db The database.
 * @param peer The peer.
 * @param table The synced table.
 * @returns The peer's counter for the last page taken from it, or null for none yet (ask for everything).
 */
export function getPullCursor(db: WingLogDb, peer: string, table: string): number | null {
  return parseCursor(getSetting(db, pullKey(peer, table)))
}

/**
 * @param db The database.
 * @param peer The peer.
 * @param table The synced table.
 * @param cursor The `cursor` the peer gave with the last page.
 */
export function setPullCursor(db: WingLogDb, peer: string, table: string, cursor: number): void {
  setSetting(db, pullKey(peer, table), String(cursor))
}

/**
 * @param db The database.
 * @param peer The peer.
 * @param table The synced table.
 * @returns The `seq` up to which this database's changes have been sent to the peer; 0 for none yet.
 */
export function getPushCursor(db: WingLogDb, peer: string, table: string): number {
  return parseCursor(getSetting(db, pushKey(peer, table))) ?? 0
}

/**
 * @param db The database.
 * @param peer The peer.
 * @param table The synced table.
 * @param seq The last `seq` the peer has accepted.
 */
export function setPushCursor(db: WingLogDb, peer: string, table: string, seq: number): void {
  setSetting(db, pushKey(peer, table), String(seq))
}

/**
 * Forgets both cursors for a peer, so the next sync with it starts from nothing in both directions: a new account has none of the old one's
 * rows, and a device pointed at a different one must not carry the first's place.
 *
 * @param db The database.
 * @param peer The peer.
 */
export function clearPeerCursors(db: WingLogDb, peer: string): void {
  db.delete(appSetting)
    .where(or(like(appSetting.key, `pullCursor:${peer}:%`), like(appSetting.key, `pushCursor:${peer}:%`)))
    .run()
}

/**
 * @param db The database.
 * @param table The synced table.
 * @param uuid The row's uuid.
 * @returns The row's own updated_at here, or undefined when there is no such row. A row pulled from a peer with the same one is the peer
 *   giving back what was just sent to it, which changes nothing and is not worth a line in the conflict log.
 */
export function localUpdatedAt(db: WingLogDb, table: string, uuid: string): string | null | undefined {
  switch (table) {
    case 'aircraft':
      return db.select({ at: aircraft.updatedAt }).from(aircraft).where(eq(aircraft.uuid, uuid)).get()?.at
    case 'flight':
      return db.select({ at: flight.updatedAt }).from(flight).where(eq(flight.uuid, uuid)).get()?.at
    case 'landing':
      return db.select({ at: landing.updatedAt }).from(landing).where(eq(landing.uuid, uuid)).get()?.at
    default:
      return db
        .select({ at: flightInvoice.updatedAt })
        .from(flightInvoice)
        .where(eq(flightInvoice.uuid, uuid))
        .get()?.at
  }
}
