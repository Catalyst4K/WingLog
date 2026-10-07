/**
 * The one-off storage tidy-up after an update (winglog-backend docs/plans/robustness/performance-and-storage.md, Part 2): compress the
 * OFPs stored as plain text, then give the freed space back to the file. It runs a few seconds after launch so it never competes with
 * startup, in the background, and logs what it did to main.log. Nothing here is user-visible, and a launch with nothing to do costs one
 * cheap query.
 */
import type { Database as SqliteDatabase } from 'better-sqlite3'
import { logger } from '../logging/logger'
import { runLogged } from '../logging/run-logged'
import { compressStoredOfps, reclaimFreeSpace } from './ofp-storage'

/** How long after launch the tidy-up starts, in milliseconds. */
const START_DELAY_MS = 10_000

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`

/**
 * Compresses stored OFPs and reclaims the space, logging the result.
 *
 * @param sqlite The open database.
 * @param backedUp Whether this launch's backup of the database succeeded; the file is only compacted if it did.
 */
export async function runStorageMaintenance(sqlite: SqliteDatabase, backedUp: boolean): Promise<void> {
  const compressed = await compressStoredOfps(sqlite)
  if (compressed.converted > 0 || compressed.skipped > 0) {
    logger.info(
      `[storage] compressed ${compressed.converted} OFPs (${mb(compressed.bytesBefore)} -> ${mb(compressed.bytesAfter)})` +
        (compressed.skipped > 0 ? `, ${compressed.skipped} left as they were` : '')
    )
  }
  const reclaimed = reclaimFreeSpace(sqlite, backedUp)
  if (reclaimed)
    logger.info(`[storage] database file ${mb(reclaimed.bytesBefore)} -> ${mb(reclaimed.bytesAfter)}`)
}

/**
 * Starts the tidy-up shortly after launch, without waiting for it.
 *
 * @param sqlite The open database.
 * @param backedUp Whether this launch's backup of the database succeeded.
 */
export function startStorageMaintenance(sqlite: SqliteDatabase, backedUp: boolean): void {
  setTimeout(() => runLogged('storage maintenance', runStorageMaintenance(sqlite, backedUp)), START_DELAY_MS)
}
