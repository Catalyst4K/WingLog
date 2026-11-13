/**
 * Sync by counters, not times (winglog-backend docs/plans/sync-cursors.md): a pull takes pages after the peer's own counter, a push sends this
 * database's counted changes after the last one the peer accepted, and a row that came from a peer is not sent back to it. The apply side is the
 * same as ever (`applyPulledRow`: last write wins by `updatedAt`, every row checked), so `updatedAt` still settles a conflict; it just no longer
 * decides which rows to look at, which is what let a row slip past a cursor taken from another clock.
 */

import {
  clearPeerCursors,
  clearPeerOrigin,
  getKnownCounter,
  getPullCursor,
  getPushCursor,
  listChangesAfter,
  localUpdatedAt,
  markOrigin,
  noteSeenFromPeer,
  setPeerEpoch,
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
  type ApplyResult,
  type SyncResult,
  type SyncSession,
  type SyncTableResult
} from './sync-engine'
import { timeSlicer } from './time-slice'

/** What this database knows of a peer's counter, sent with a pull (review of M8): the highest number it has shown, and its epoch. */
export interface KnownCounter {
  seen: number | null
  epoch: string | null
}

/**
 * One page as a peer serves it. `head` is the peer's highest change number and `epoch` names its counter's present run of numbers; an older
 * peer sends neither.
 */
export interface PulledPage {
  rows: SyncRow[]
  cursor: number
  more: boolean
  head?: number
  epoch?: string
}

/** A peer that serves pages: the cloud, or the sim PC's host. */
export interface PagedSyncClient {
  syncPullPage(
    email: string,
    token: string,
    table: SyncTable,
    cursor: number | null,
    known: KnownCounter
  ): Promise<PulledPage>
  syncPush(
    email: string,
    token: string,
    table: SyncTable,
    rows: SyncRow[]
  ): Promise<{ upserted: string[]; rejected: string[]; refused?: string[]; head?: number }>
}

/** Changes read from the counter at a time; a push is then split by the backend's own row and byte limits. */
const PUSH_CHUNK = 500

/** Thrown when a peer's counter is found to have gone back, so the sync run starts again from the first table (review of M8). */
class PeerCounterWentBack extends Error {}

/**
 * @param known What this database knew of the peer's counter before the page.
 * @param page The page.
 * @returns True when the peer's counter has gone back: it has a new epoch, or it says a head below a number it has shown before. A peer that
 *   sends neither (an older one) is never taken to have.
 */
function peerCounterWentBack(known: KnownCounter, page: PulledPage): boolean {
  if (page.epoch !== undefined && known.epoch !== null && page.epoch !== known.epoch) return true
  return known.seen !== null && page.head !== undefined && known.seen > page.head
}

/**
 * @param db The database.
 * @param peer The peer.
 * @param cursor The cursor about to be sent.
 * @returns What this database knows of the peer's counter, to send with the pull. The cursor counts as seen too: a database from before `seen`
 *   was kept has only its cursors.
 */
function knownBeforePull(db: WingLogDb, peer: string, cursor: number | null): KnownCounter {
  const stored = getKnownCounter(db, peer)
  return { seen: cursor === null ? stored.seen : Math.max(stored.seen ?? 0, cursor), epoch: stored.epoch }
}

/**
 * Takes what a page says of the peer's counter: its epoch, and the highest number it has shown. When the counter went back (the account was made
 * again, a backup was restored, or a twin met a new sim PC database), nothing after the cursors will ever come, and the push cursors say rows were
 * sent that were not: the peer is started again, so everything is taken and sent, from the first table, so a child is never pulled before a parent
 * it now needs. Last write wins makes that safe, and it costs one full sync.
 *
 * @param db The database.
 * @param dbPath The database file's path, which says where sync-conflicts.log goes.
 * @param peer The peer.
 * @param table The table the page is for.
 * @param known What was known of the counter when the page was asked for.
 * @param page The page.
 * @throws PeerCounterWentBack when the counter went back, after the peer is reset, so the run starts again.
 */
function takePageCounter(
  db: WingLogDb,
  dbPath: string,
  peer: string,
  table: SyncTable,
  known: KnownCounter,
  page: PulledPage
): void {
  if (peerCounterWentBack(known, page)) {
    resetPeer(db, peer)
    logSyncEvent(dbPath, {
      direction: 'pull',
      table,
      uuid: '',
      reason: `the peer's counter went back (epoch ${known.epoch ?? 'none'} to ${page.epoch ?? 'none'}, seen ${known.seen ?? 'nothing'}, head ${page.head ?? 'not sent'}), so everything is synced again`
    })
    throw new PeerCounterWentBack(
      `The ${peer} sync's counter went back during the sync; it is tried again next time.`
    )
  }
  if (page.epoch !== undefined && page.epoch !== known.epoch) setPeerEpoch(db, peer, page.epoch)
  noteSeenFromPeer(db, peer, Math.max(page.cursor, page.head ?? 0))
}

/**
 * Applies one pulled row, counts it in the result, and logs what was not applied.
 *
 * @param db The database.
 * @param dbPath The database file's path, which says where sync-conflicts.log goes.
 * @param peer Who the row came from.
 * @param table The table.
 * @param row The row.
 * @param result What to add the row to.
 * @returns How the apply went.
 */
function applyPageRow(
  db: WingLogDb,
  dbPath: string,
  peer: string,
  table: SyncTable,
  row: SyncRow,
  result: SyncTableResult
): ApplyResult {
  const outcome = applyPulledRow(db, table, row)
  if (!outcome.ok) {
    result.skipped.push(row.uuid)
    logSyncEvent(dbPath, { direction: 'pull', table, uuid: row.uuid, reason: outcome.error })
  } else if (outcome.applied) {
    result.pulled++
    // Marked on the uuid the row was written under: a flight or aircraft merged into one already here counts under the local uuid.
    markOrigin(db, table, outcome.uuid, peer)
  } else if (!isSameTime(localUpdatedAt(db, table, outcome.uuid), row.updatedAt)) {
    result.rejected.push(row.uuid)
    logSyncEvent(dbPath, {
      direction: 'pull',
      table,
      uuid: row.uuid,
      reason: 'local already had a newer or equal updatedAt (last-write-wins)'
    })
  }
  // Otherwise the peer gave back the row just sent to it (or one this device already took): the same write, so nothing to report.
  return outcome
}

/**
 * @param stored A row's time as stored here (always in `toISOString`'s form), or nothing.
 * @param pulled A pulled row's time, which may be written another way (`…:00Z` for `…:00.000Z`).
 * @returns True when they are the same moment.
 */
function isSameTime(stored: string | null | undefined, pulled: string): boolean {
  return stored != null && Date.parse(stored) === Date.parse(pulled)
}

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
  // Kept only for the aircraft table, the one that links replacements afterwards: a first pull of the flight table would hold every flight in memory.
  const pulledRows: { row: SyncRow; applied: boolean }[] = []
  let cursor = getPullCursor(db, peer, table)
  // A page can be hundreds of rows: the app gets the thread back between rows.
  const slice = timeSlicer()
  for (;;) {
    const known = knownBeforePull(db, peer, cursor)
    const page = await client.syncPullPage(session.email, session.token, table, cursor, known)
    takePageCounter(db, dbPath, peer, table, known, page)
    for (const row of page.rows) {
      await slice()
      const outcome = applyPageRow(db, dbPath, peer, table, row, result)
      if (outcome.ok && table === 'aircraft') pulledRows.push({ row, applied: outcome.applied })
    }
    if (page.more && page.cursor <= (cursor ?? 0)) throw new Error('The backend did not move the cursor on.')
    cursor = page.cursor
    setPullCursor(db, peer, table, cursor)
    if (!page.more) break
  }
  if (table === 'aircraft') linkPulledReplacements(db, pulledRows)
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
  const slice = timeSlicer()
  for (;;) {
    const changes = listChangesAfter(db, table, after, PUSH_CHUNK)
    if (changes.length === 0) break
    const rows: SyncRow[] = []
    for (const change of changes) {
      if (change.origin === peer) continue
      await slice()
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
        refused = [],
        head
      } = await client.syncPush(session.email, session.token, table, batch)
      // The peer's counter after the push: a restore to just before it still shows at the next pull.
      if (head !== undefined) noteSeenFromPeer(db, peer, head)
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
 * @param syncTables The tables to sync; the peer's own list (the cloud's Worker takes four), all of them by default.
 * @returns What was pulled, pushed and skipped.
 */
export async function runCursorSync(
  db: WingLogDb,
  client: PagedSyncClient,
  session: SyncSession,
  dbPath: string,
  peer: string,
  syncTables: readonly SyncTable[] = SYNC_TABLES
): Promise<SyncResult> {
  const nothing = (): SyncTableResult => ({ pulled: 0, pushed: 0, rejected: [], skipped: [] })
  const tables: Record<SyncTable, SyncTableResult> = {
    aircraft: nothing(),
    flight: nothing(),
    landing: nothing(),
    flightInvoice: nothing(),
    gsxRoutine: nothing()
  }
  // When the peer's counter is found to have gone back, the peer is reset and the whole run starts again from the first table, once: a
  // table already done this run used the old cursors (review of M8). Found again in the same run, the sync fails and is tried next time.
  for (let attempt = 0; ; attempt++) {
    try {
      for (const table of syncTables) {
        const result: SyncTableResult = { pulled: 0, pushed: 0, rejected: [], skipped: [] }
        await pullTable(db, client, session, dbPath, peer, table, result)
        await pushTable(db, client, session, dbPath, peer, table, result)
        tables[table] = result
      }
      return { syncedAt: new Date().toISOString(), tables }
    } catch (error) {
      if (!(error instanceof PeerCounterWentBack) || attempt > 0) throw error
    }
  }
}

/**
 * Forgets what a peer has been sent and given, and which rows came from it, so the next sync with it is a full one in both directions: a
 * new or restored peer may no longer have the rows it once sent here, so they are sent back too (review of M8).
 *
 * @param db The database.
 * @param peer The peer.
 */
export function resetPeer(db: WingLogDb, peer: string): void {
  clearPeerCursors(db, peer)
  clearPeerOrigin(db, peer)
}
