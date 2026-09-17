import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createDb } from './client'

// migrationsFolder defaults to a cwd-relative path — correct for scripts/db-migrate.ts
// and tests, which always run from the project root. The real app can't rely on cwd (a
// packaged app's cwd depends on how it was launched, not on where its files live), so
// src/main/index.ts passes an absolute path derived from app.getAppPath() instead.
export function migrateDb(dbPath: string, migrationsFolder = 'drizzle'): void {
  const { sqlite, db } = createDb(dbPath)
  // drizzle-orm's own migrator (sqlite-core/dialect.js) runs every pending migration's SQL
  // inside one `BEGIN`/`COMMIT` it opens itself — so a migration file's own `PRAGMA
  // foreign_keys=OFF` (needed by any migration that recreates a table, e.g. 0024's
  // flight.aircraft_id -> nullable) is a documented no-op: SQLite ignores that pragma while
  // a transaction is already open. createDb() above always leaves foreign_keys ON for
  // normal app use, so it has to be turned off out here, before migrate() ever opens its
  // transaction, for a table-recreating migration's DROP TABLE to succeed against a real
  // database with child rows (landing/track_point/flight_invoice, all FK'd to flight.id) —
  // confirmed for real (Callum, 2026-09-17): "WingLog failed to start" on a real installed
  // build, DrizzleError on `DROP TABLE 'flight';`. Restored to ON once migration is done, so
  // every ordinary query after this runs with enforcement as normal.
  sqlite.pragma('foreign_keys = OFF')
  try {
    migrate(db, { migrationsFolder })
  } finally {
    sqlite.pragma('foreign_keys = ON')
  }
  sqlite.close()
}
