import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'

/**
 * DB backup-on-launch (PLAN.md §M7) — a local safety net against a bad migration or a
 * corrupted database, not a substitute for cloud sync or a real backup strategy. Runs once
 * per launch, before migrateDb() applies whatever new migrations shipped in this version,
 * so "the last thing written before the schema changed" is always recoverable by hand.
 *
 * Snapshots via `VACUUM INTO`, the same technique legacy-userdata.ts uses: the DB runs in
 * WAL mode (client.ts), so a plain file copy of winglog.db alone can miss committed
 * transactions still sitting in winglog.db-wal. Opening the live database and vacuuming
 * into the backup path replays the WAL first, producing one consistent file.
 */

const BACKUP_FILENAME_PREFIX = 'winglog-'
const BACKUP_FILENAME_SUFFIX = '.db'
const DEFAULT_KEEP = 5

/**
 * Writes a timestamped snapshot of `dbPath` into `backupsDir`, then prunes older snapshots
 * beyond `keep`. A no-op if `dbPath` doesn't exist yet — a fresh install has nothing to
 * back up on its first launch.
 */
export function backupDatabaseOnLaunch(dbPath: string, backupsDir: string, keep = DEFAULT_KEEP): void {
  if (!existsSync(dbPath)) return

  mkdirSync(backupsDir, { recursive: true })
  // Colons aren't valid in a Windows filename, so toISOString()'s punctuation is stripped
  // rather than replaced — including dashes, which matters here: a filename that mixes
  // digits and dashes no longer lexically sorts the same as it chronologically orders
  // ('-' sorts before '0' in ASCII), which is what pruneOldBackups relies on below.
  const timestamp = new Date().toISOString().replace(/[-:.]/g, '')
  const target = join(backupsDir, `${BACKUP_FILENAME_PREFIX}${timestamp}${BACKUP_FILENAME_SUFFIX}`)

  // Opened read-write, not readonly — matches legacy-userdata.ts's copyDatabaseConsistently,
  // which opens read-write specifically so any content still sitting in the WAL is replayed
  // before the snapshot is taken rather than relying on VACUUM INTO's read-only WAL support.
  const sqlite = new Database(dbPath)
  try {
    // Bound rather than interpolated: userData paths can legitimately contain a quote, and
    // VACUUM INTO takes an expression, so a parameter is valid here (matches
    // legacy-userdata.ts's copyDatabaseConsistently).
    sqlite.prepare('VACUUM INTO ?').run(target)
  } finally {
    sqlite.close()
  }

  pruneOldBackups(backupsDir, keep)
}

function pruneOldBackups(backupsDir: string, keep: number): void {
  const backups = readdirSync(backupsDir)
    .filter((name) => name.startsWith(BACKUP_FILENAME_PREFIX) && name.endsWith(BACKUP_FILENAME_SUFFIX))
    .sort()
  const toDelete = backups.slice(0, Math.max(0, backups.length - keep))
  for (const name of toDelete) {
    unlinkSync(join(backupsDir, name))
  }
}
