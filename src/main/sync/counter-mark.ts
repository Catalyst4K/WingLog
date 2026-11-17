/**
 * A high-water mark of this database's change counter, kept in a small file beside the database, not in it (winglog-backend's
 * docs/plans/security-audit-v2.md, review of 2026-11-17, finding 2). A database restored from a backup brings its own epoch and counter back
 * with it, so neither tells a peer that numbers it has already seen are being given out again; this file is not restored with the database, so
 * at launch a counter below it says the database went back, and the epoch is changed so every peer starts again.
 *
 * The mark is raised whenever a peer could have learned of the counter: the sim PC when it answers a twin, a twin before each push to the sim PC and when a sync ends. It is the
 * app's own file but is read as untrusted: a missing or garbled one means no mark, which never changes the epoch and never throws.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { WingLogDb } from '../db/client'
import { highestChangeSeq, startNewEpoch } from '../db/sync-change-repo'
import { logger } from '../logging/logger'

/** The file's name, in the same folder as the database. */
const MARK_FILE = 'sync-counter-mark.json'

/**
 * @param dbPath The database file's path.
 * @returns Where its counter mark is kept.
 */
export function counterMarkPath(dbPath: string): string {
  return join(dirname(dbPath), MARK_FILE)
}

/**
 * @param dbPath The database file's path.
 * @returns The highest counter noted for this database, or null when there is no mark or the file is not one.
 */
export function readCounterMark(dbPath: string): number | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(counterMarkPath(dbPath), 'utf8'))
    const seq =
      typeof parsed === 'object' && parsed !== null ? (parsed as { changeSeq?: unknown }).changeSeq : null
    return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 ? seq : null
  } catch {
    // Not there, or not JSON: the same as never noted.
    return null
  }
}

/**
 * Writes the mark whole or not at all, so a crash part-way leaves the old one. A failure is logged and goes no further: the sync that asked
 * must not fail for want of a file.
 *
 * @param dbPath The database file's path.
 * @param seq The counter to keep.
 */
function writeCounterMark(dbPath: string, seq: number): void {
  const path = counterMarkPath(dbPath)
  try {
    writeFileSync(`${path}.tmp`, JSON.stringify({ changeSeq: seq }))
    renameSync(`${path}.tmp`, path)
  } catch (error) {
    logger.warn('[sync] could not keep the change counter mark:', error)
  }
}

/**
 * Notes the counter now, when it is higher than the mark. Called after a peer was told of numbers (the sim PC answering a twin) or could have
 * been (a twin pushing to the sim PC, or its sync ending): any later restore of the database to before them then shows as a counter below the mark.
 *
 * @param db The database.
 * @param dbPath The database file's path.
 */
export function raiseCounterMark(db: WingLogDb, dbPath: string): void {
  const current = highestChangeSeq(db)
  const mark = readCounterMark(dbPath)
  if (mark === null || current > mark) writeCounterMark(dbPath, current)
}

/**
 * Run once at launch, before any sync: a counter below the mark means this database is an older one put back (a backup restored), so it gets a
 * new epoch, which makes every device that syncs with it start again. The mark then follows the database. With no mark (a first launch, or a
 * file that is missing or garbled) nothing changes and the mark is made.
 *
 * @param db The database.
 * @param dbPath The database file's path.
 * @returns True when the database was found to have been restored and its epoch was changed.
 */
export function reconcileCounterMark(db: WingLogDb, dbPath: string): boolean {
  const current = highestChangeSeq(db)
  const mark = readCounterMark(dbPath)
  const restored = mark !== null && current < mark
  if (restored) {
    startNewEpoch(db)
    logger.warn(
      `[sync] the change counter (${current}) is below its mark (${mark}): the database was restored, so its epoch is new`
    )
  }
  if (mark === null || restored || current > mark) writeCounterMark(dbPath, current)
  return restored
}
