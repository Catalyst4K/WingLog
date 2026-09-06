import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'

/**
 * The app was called Flightdeck until the 2026-09-06 rename to WingLog
 * (flightdeck-backend/docs/decisions.md). Electron derives userData from the app name, so
 * the rename moved `~/Library/Application Support/Flightdeck` to `.../WingLog` (and
 * `%APPDATA%\Flightdeck` likewise) — leaving every existing install's logbook sitting in a
 * directory the app no longer looks at. This carries it across, once, on first launch
 * under the new name.
 *
 * Two deliberate choices:
 *
 * - **The database is copied with `VACUUM INTO`, not `copyFileSync`.** The DB runs in WAL
 *   mode (see client.ts), so committed transactions can live in `flightdeck.db-wal`
 *   rather than in the main file. Copying only the `.db` would silently drop them;
 *   copying all three files risks a torn set. Opening the source replays its WAL, and
 *   `VACUUM INTO` then writes a single consistent file.
 * - **Nothing is deleted.** The legacy directory is left exactly as it was, so a
 *   migration that goes wrong is always recoverable by hand. Disk is cheap; a logbook
 *   isn't.
 */

/** Both cases are checked: packaged builds used productName ("Flightdeck"), dev used the
 *  package name ("flightdeck"). They're the same directory on macOS/Windows, different on
 *  a case-sensitive filesystem, and checking both costs nothing. */
const LEGACY_APP_DIR_NAMES = ['Flightdeck', 'flightdeck']
const LEGACY_DB_FILENAME = 'flightdeck.db'

/** Non-database files worth carrying over. Anything absent is skipped silently — a fresh
 *  install has never signed in to cloud sync and has no conflict log. */
const LEGACY_SIDECAR_FILES = ['cloud-session.enc', 'sync-conflicts.log']

export interface LegacyMigrationResult {
  migrated: boolean
  /** The directory the data came from, when a migration actually happened. */
  from?: string
  /** Sidecar filenames copied alongside the database. */
  sidecars: string[]
}

/**
 * Copies a pre-rename Flightdeck userData directory into the current one, if there is one
 * to copy and the new database doesn't already exist. Safe to call on every launch: it is
 * a no-op once `dbPath` is present, which it always is after the first run.
 */
export function migrateLegacyUserData(
  userDataPath: string,
  dbPath: string
): LegacyMigrationResult {
  // Already running under the new name with real data — nothing to do, and in particular
  // never overwrite a database that exists.
  if (existsSync(dbPath)) return { migrated: false, sidecars: [] }

  const legacyDir = findLegacyDir(userDataPath)
  if (!legacyDir) return { migrated: false, sidecars: [] }

  mkdirSync(userDataPath, { recursive: true })
  copyDatabaseConsistently(join(legacyDir, LEGACY_DB_FILENAME), dbPath)

  const sidecars: string[] = []
  for (const name of LEGACY_SIDECAR_FILES) {
    const source = join(legacyDir, name)
    const target = join(userDataPath, name)
    if (existsSync(source) && !existsSync(target)) {
      copyFileSync(source, target)
      sidecars.push(name)
    }
  }

  return { migrated: true, from: legacyDir, sidecars }
}

/** Looks for a legacy directory beside the current userData directory, identified by it
 *  actually containing a Flightdeck database rather than by merely existing. */
function findLegacyDir(userDataPath: string): string | null {
  const parent = dirname(userDataPath)
  for (const name of LEGACY_APP_DIR_NAMES) {
    const candidate = join(parent, name)
    // Guard against a case-insensitive filesystem resolving a candidate back to the
    // directory we're migrating *into*, which would make this copy a file onto itself.
    if (candidate === userDataPath) continue
    if (existsSync(join(candidate, LEGACY_DB_FILENAME))) return candidate
  }
  return null
}

function copyDatabaseConsistently(source: string, target: string): void {
  // Opening the source read-write is what replays any WAL content into the main database;
  // a read-only handle would not, which is the whole reason this isn't a file copy.
  const sqlite = new Database(source)
  try {
    // Bound rather than interpolated: a userData path can legitimately contain a quote,
    // and VACUUM INTO takes an expression, so a parameter is valid here.
    sqlite.prepare('VACUUM INTO ?').run(target)
  } finally {
    sqlite.close()
  }
}
