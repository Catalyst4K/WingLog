import Database, { type Database as SqliteDatabase } from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'

export interface WingLogDbHandle {
  sqlite: SqliteDatabase
  db: BetterSQLite3Database<typeof schema>
}

export function createDb(dbPath: string): WingLogDbHandle {
  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  return { sqlite, db }
}

export type WingLogDb = BetterSQLite3Database<typeof schema>
