/**
 * Storage maintenance for the OFP column (winglog-backend docs/plans/robustness/performance-and-storage.md, Part 2): converts the
 * OFPs stored before compression existed, then gives the freed space back to the file. Both are one-off and lossless: each row is
 * read back and compared with the original before it replaces it, and the file is only compacted when this launch's backup of the
 * database exists.
 */
import type { Database as SqliteDatabase } from 'better-sqlite3'
import { compressText, decompressText } from './compressed-text'

/** Free space smaller than this isn't worth rewriting the file for. */
const MIN_RECLAIM_BYTES = 16 * 1024 * 1024
/** Nor is free space under this share of the file. */
const MIN_RECLAIM_SHARE = 0.25

/** What a conversion did. */
export interface CompressionResult {
  /** Rows converted. */
  converted: number
  /** Rows that couldn't be (left as they were). */
  skipped: number
  bytesBefore: number
  bytesAfter: number
}

/**
 * Compresses every OFP still stored as plain text. Each row is compressed, decompressed and compared with the original before
 * it replaces it; one that doesn't round-trip is left alone. Gives the event loop back between rows, so the window stays
 * responsive. Safe to run again: it only touches rows still stored as text, and changes nothing else about a flight (not its
 * `updated_at`, so nothing is re-synced).
 *
 * @param sqlite The open database.
 * @returns How many rows were converted and the OFP bytes before and after.
 */
export async function compressStoredOfps(sqlite: SqliteDatabase): Promise<CompressionResult> {
  const ids = sqlite.prepare("SELECT id FROM flight WHERE typeof(ofp_json) = 'text'").all() as {
    id: number
  }[]
  const read = sqlite.prepare(
    "SELECT ofp_json AS text FROM flight WHERE id = ? AND typeof(ofp_json) = 'text'"
  )
  // Guarded again on the type, so a row the app rewrote since the list was taken isn't overwritten with the older text.
  const write = sqlite.prepare("UPDATE flight SET ofp_json = ? WHERE id = ? AND typeof(ofp_json) = 'text'")
  const result: CompressionResult = { converted: 0, skipped: 0, bytesBefore: 0, bytesAfter: 0 }
  for (const { id } of ids) {
    const row = read.get(id) as { text: string } | undefined
    if (row) {
      const packed = compressText(row.text)
      if (decompressText(packed) === row.text) {
        const changed = sqlite.transaction(() => write.run(packed, id).changes)()
        if (changed > 0) {
          result.converted++
          result.bytesBefore += Buffer.byteLength(row.text, 'utf8')
          result.bytesAfter += packed.length
        }
      } else {
        result.skipped++
      }
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return result
}

/** What a compaction did. */
export interface ReclaimResult {
  bytesBefore: number
  bytesAfter: number
}

/**
 * Rewrites the database file without its free pages (`VACUUM`), when there are enough of them to matter (conversion leaves most of
 * the old OFP pages free). A VACUUM is atomic, but it rewrites the whole file, so it only runs when the caller says a backup of
 * this launch exists, and the result is checked with `integrity_check`.
 *
 * @param sqlite The open database.
 * @param backedUp Whether this launch's backup of the database succeeded.
 * @returns The file size before and after, or null when there was nothing worth reclaiming or no backup.
 * @throws When the integrity check fails after the VACUUM (the launch backup holds the earlier state).
 */
export function reclaimFreeSpace(sqlite: SqliteDatabase, backedUp: boolean): ReclaimResult | null {
  if (!backedUp) return null
  const pageSize = sqlite.pragma('page_size', { simple: true }) as number
  const bytesBefore = (sqlite.pragma('page_count', { simple: true }) as number) * pageSize
  const freeBytes = (sqlite.pragma('freelist_count', { simple: true }) as number) * pageSize
  if (freeBytes < MIN_RECLAIM_BYTES || freeBytes < bytesBefore * MIN_RECLAIM_SHARE) return null
  sqlite.exec('VACUUM')
  sqlite.pragma('wal_checkpoint(TRUNCATE)')
  const integrity = sqlite.pragma('integrity_check', { simple: true })
  if (integrity !== 'ok') throw new Error(`integrity_check after VACUUM: ${String(integrity)}`)
  return { bytesBefore, bytesAfter: (sqlite.pragma('page_count', { simple: true }) as number) * pageSize }
}
