/**
 * Sync by counters, not times (winglog-backend docs/plans/sync-cursors.md): a pull takes pages after the peer's own counter, a push sends this
 * database's counted changes after the last one the peer accepted, and a row that came from a peer is not sent back to it. The apply side is the
 * same as ever (`applyPulledRow`: last write wins by `updatedAt`, every row checked), so `updatedAt` still settles a conflict; it just no longer
 * decides which rows to look at, which is what let a row slip past a cursor taken from another clock.
 */

import {
  clearPeerCursors,
  getPullCursor,
  getPushCursor,
  listChangesAfter,
  localUpdatedAt,
  markOrigin,
  setPullCursor,
  setPushCursor
} from '../db/sync-change-repo'
import type { WingLogDb } from '../db/client'
import { SYNC_TABLES, type SyncRow, type SyncTable } from '../backend/sync-client'
import {
  applyPulledRow,
  linkPulledReplacements,
  logSyncEvent,
  serializeChange,
  splitPushBatches,
  type SyncResult,
  type SyncSession,
  type SyncTableResult
} from './sync-engine'

/** A peer that serves pages: the cloud, or the sim PC's host. */
export interface PagedSyncClient {
  syncPullPage(
    email: string,
    token: string,
    table: SyncTable,
    cursor: number | null
  ): Promise<{ rows: SyncRow[]; cursor: number; more: boolean }>
  syncPush(
    email: string,
    token: string,
    table: SyncTable,
    rows: SyncRow[]
  ): Promise<{ upserted: string[]; rejected: string[]; refused?: string[] }>
}

/** Changes read from the counter at a time; a push is then split by the backend's own row and byte limits. */
const PUSH_CHUNK = 500

/**
 * Takes every page the peer has after this database's cursor for the table, applying each row and saving the cursor after each page, so a pull
 * that fails part-way carries on from where it stopped instead of starting again.
 *
 * @param db The database.
 * @param client The peer.
 * @param session The signed-in session.
 * @param dbPath The database file's path, which says where sync-conflicts.log goes.
 * @param peer Who the rows come from.
 * @param table The table.
 * @param result What to add this table's pull to.
 */
async function pullTable(
  db: WingLogDb,
  client: PagedSyncClient,
  session: SyncSession,
  dbPath: string,
  peer: string,
  table: SyncTable,
  result: SyncTableResult
): Promise<void> {
  const appliedRows: SyncRow[] = []
  let cursor = getPullCursor(db, peer, table)
  for (;;) {
    const page = await client.syncPullPage(session.email, session.token, table, cursor)
    for (const row of page.rows) {
      const outcome = applyPulledRow(db, table, row)
      if (!outcome.ok) {
        result.skipped.push(row.uuid)
        logSyncEvent(dbPath, { direction: 'pull', table, uuid: row.uuid, reason: outcome.error })
      } else if (outcome.applied) {
        result.pulled++
        appliedRows.push(row)
        // Marked on the uuid the row was written under: a flight or aircraft merged into one already here counts under the local uuid.
        markOrigin(db, table, outcome.uuid, peer)
      } else if (localUpdatedAt(db, table, outcome.uuid) === row.updatedAt) {
        // The peer giving back the row just sent to it (or one this device already took): the same write, so nothing to report.
        continue
      } else {
        result.rejected.push(row.uuid)
        logSyncEvent(dbPath, {
          direction: 'pull',
          table,
          uuid: row.uuid,
          reason: 'local already had a newer or equal updatedAt (last-write-wins)'
        })
      }
    }
    if (page.more && page.cursor <= (cursor ?? 0)) throw new Error('The backend did not move the cursor on.')
    cursor = page.cursor
    setPullCursor(db, peer, table, cursor)
    if (!page.more) break
  }
  if (table === 'aircraft') linkPulledReplacements(db, appliedRows)
}

/**
 * Sends the counted changes after the peer's push cursor, except the ones that came from that peer, and saves the cursor after each chunk
 * the peer has taken. A change that cannot be sent (its row is gone, or its parent has no uuid yet) is logged and passed over rather than
 * stopping every later change behind it.
 *
 * @param db The database.
 * @param client The peer.
 * @param session The signed-in session.
 * @param dbPath The database file's path.
 * @param peer Who to send to.
 * @param table The table.
 * @param result What to add this table's push to.
 */
async function pushTable(
  db: WingLogDb,
  client: PagedSyncClient,
  session: SyncSession,
  dbPath: string,
  peer: string,
  table: SyncTable,
  result: SyncTableResult
): Promise<void> {
  let after = getPushCursor(db, peer, table)
  for (;;) {
    const changes = listChangesAfter(db, table, after, PUSH_CHUNK)
    if (changes.length === 0) break
    const rows: SyncRow[] = []
    for (const change of changes) {
      if (change.origin === peer) continue
      const row = serializeChange(db, table, change.uuid)
      if (row) rows.push(row)
      else {
        result.skipped.push(change.uuid)
        logSyncEvent(dbPath, {
          direction: 'push',
          table,
          uuid: change.uuid,
          reason: 'could not be sent: its row is gone or its parent has no uuid'
        })
      }
    }
    const { batches, oversize } = splitPushBatches(rows)
    for (const uuid of oversize) {
      result.skipped.push(uuid)
      logSyncEvent(dbPath, { direction: 'push', table, uuid, reason: 'row data too large for the backend' })
    }
    for (const batch of batches) {
      const {
        upserted,
        rejected,
        refused = []
      } = await client.syncPush(session.email, session.token, table, batch)
      result.pushed += upserted.length
      result.rejected.push(...rejected)
      for (const uuid of rejected) {
        logSyncEvent(dbPath, {
          direction: 'push',
          table,
          uuid,
          reason: 'server already had a newer updatedAt (last-write-wins)'
        })
      }
      for (const uuid of refused) {
        result.skipped.push(uuid)
        logSyncEvent(dbPath, {
          direction: 'push',
          table,
          uuid,
          reason: 'refused by the backend: not a valid row'
        })
      }
    }
    after = changes[changes.length - 1].seq
    setPushCursor(db, peer, table, after)
    if (changes.length < PUSH_CHUNK) break
  }
}

/**
 * One full pull-then-push cycle with a peer across the four synced tables, in dependency order.
 *
 * @param db The database.
 * @param client The peer.
 * @param session The signed-in session.
 * @param dbPath The database file's path, which says where sync-conflicts.log goes.
 * @param peer Who this is: `cloud`, `host`, or on the sim PC `twin:<device id>`. Its cursors and its rows' origin are kept under this name.
 * @returns What was pulled, pushed and skipped.
 */
export async function runCursorSync(
  db: WingLogDb,
  client: PagedSyncClient,
  session: SyncSession,
  dbPath: string,
  peer: string
): Promise<SyncResult> {
  const tables = {} as Record<SyncTable, SyncTableResult>
  for (const table of SYNC_TABLES) {
    const result: SyncTableResult = { pulled: 0, pushed: 0, rejected: [], skipped: [] }
    await pullTable(db, client, session, dbPath, peer, table, result)
    await pushTable(db, client, session, dbPath, peer, table, result)
    tables[table] = result
  }
  return { syncedAt: new Date().toISOString(), tables }
}

/**
 * Forgets what a peer has been sent and given, so the next sync with it is a full one in both directions.
 *
 * @param db The database.
 * @param peer The peer.
 */
export function resetPeer(db: WingLogDb, peer: string): void {
  clearPeerCursors(db, peer)
}
