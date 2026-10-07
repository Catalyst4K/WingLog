/**
 * Opens the SQLite database through Drizzle, in WAL mode with foreign keys enforced.
 */
import Database, { type Database as SqliteDatabase } from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'

export interface WingLogDbHandle {
  sqlite: SqliteDatabase
  db: BetterSQLite3Database<typeof schema>
}

/**
 * Opens the database.
 *
 * @param dbPath The database file, or ':memory:' in tests.
 * @returns The raw connection and the Drizzle client.
 */
export function createDb(dbPath: string): WingLogDbHandle {
  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  return { sqlite, db }
}

export type WingLogDb = BetterSQLite3Database<typeof schema>
