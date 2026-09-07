// Applies Drizzle migrations to a standalone DB file, outside Electron —
// useful in dev and CI. The running app calls migrateDb() itself on launch,
// against the DB in Electron's userData directory.
import { migrateDb } from '../src/main/db/migrate'

const dbPath = process.env.WINGLOG_DB_PATH ?? './winglog.db'
migrateDb(dbPath)
console.log(`Migrated ${dbPath}`)
