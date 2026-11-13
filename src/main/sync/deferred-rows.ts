/**
 * Keeping and trying again a peer's rows that were refused only because their time is more than a day ahead of this computer's clock
 * (winglog-backend's docs/plans/security-audit-v2.md, step 23). The check itself stays (audit M2: a far-future time would win every
 * conflict), but the cursor moves past every row of a page, so a row refused for a clock that is slow here would never come again. It is kept
 * instead, and applied by the same last-write-wins apply once this computer's clock has caught up, at the next sync with that peer.
 */

import type { WingLogDb } from '../db/client'
import { dropDeferredRow, listDeferredRows } from '../db/sync-deferred-repo'
import { markOrigin } from '../db/sync-change-repo'
import type { SyncRow, SyncTable } from '../backend/sync-client'
import { applyPulledRow, linkPulledReplacements, logSyncEvent, type ApplyResult } from './sync-engine'

/**
 * Applies the rows kept for a peer and table whose time is no longer ahead of this computer's clock, by last write wins as any pulled row, and
 * forgets each one tried. A row still ahead stays kept.
 *
 * @param db The database.
 * @param dbPath The database file's path, which says where sync-conflicts.log goes.
 * @param peer Who the rows came from.
 * @param table The table.
 * @returns How many were applied.
 */
export function retryDeferredRows(db: WingLogDb, dbPath: string, peer: string, table: SyncTable): number {
  let applied = 0
  const tried: { row: SyncRow; applied: boolean }[] = []
  for (const row of listDeferredRows(db, peer, table)) {
    const outcome: ApplyResult = applyPulledRow(db, table, row)
    if (!outcome.ok && outcome.isAheadOfClock) continue
    dropDeferredRow(db, peer, table, row.uuid)
    if (!outcome.ok) {
      logSyncEvent(dbPath, { direction: 'pull', table, uuid: row.uuid, reason: outcome.error })
      continue
    }
    tried.push({ row, applied: outcome.applied })
    if (outcome.applied) {
      applied++
      markOrigin(db, table, outcome.uuid, peer)
    }
  }
  if (table === 'aircraft' && tried.length > 0) linkPulledReplacements(db, tried)
  return applied
}
