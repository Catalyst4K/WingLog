import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateLegacyUserData } from './legacy-userdata'

// Covers the 2026-09-06 Flightdeck -> WingLog rename. The rename moves Electron's
// userData directory, so without this the app silently starts with an empty logbook while
// the real one sits in the old directory. The WAL case below is the reason this uses
// VACUUM INTO rather than copyFileSync.
describe('migrateLegacyUserData', () => {
  let parent: string

  /** A legacy Flightdeck userData directory with a database and `rows` flights in it.
   *  Returns the still-open handle so a caller can leave data uncheckpointed. */
  function seedLegacy(dirName = 'Flightdeck', rows = ['EGLL', 'KJFK']): Database.Database {
    const dir = join(parent, dirName)
    mkdirSync(dir, { recursive: true })
    const sqlite = new Database(join(dir, 'flightdeck.db'))
    sqlite.pragma('journal_mode = WAL')
    // Never checkpoint automatically: everything written below stays in the -wal file, so
    // a naive copy of just the .db would come back empty. That is the bug being guarded.
    sqlite.pragma('wal_autocheckpoint = 0')
    sqlite.exec('create table flight (id integer primary key, origin text not null)')
    for (const origin of rows) {
      sqlite.prepare('insert into flight (origin) values (?)').run(origin)
    }
    return sqlite
  }

  function readOrigins(dbPath: string): string[] {
    const sqlite = new Database(dbPath, { readonly: true })
    try {
      return sqlite
        .prepare('select origin from flight order by id')
        .all()
        .map((row) => (row as { origin: string }).origin)
    } finally {
      sqlite.close()
    }
  }

  afterEach(() => {
    if (parent) rmSync(parent, { recursive: true, force: true })
  })

  it('carries a legacy database across, including rows still sitting in the WAL', () => {
    parent = mkdtempSync(join(tmpdir(), 'winglog-legacy-test-'))
    // Deliberately still open, and never checkpointed, while the migration runs.
    const legacy = seedLegacy()

    const userData = join(parent, 'WingLog')
    const dbPath = join(userData, 'winglog.db')
    const result = migrateLegacyUserData(userData, dbPath)

    expect(result.migrated).toBe(true)
    expect(result.from).toBe(join(parent, 'Flightdeck'))
    expect(readOrigins(dbPath)).toEqual(['EGLL', 'KJFK'])
    legacy.close()
  })

  it('leaves the legacy directory untouched so a bad migration stays recoverable', () => {
    parent = mkdtempSync(join(tmpdir(), 'winglog-legacy-test-'))
    const legacy = seedLegacy()
    const userData = join(parent, 'WingLog')

    migrateLegacyUserData(userData, join(userData, 'winglog.db'))

    expect(existsSync(join(parent, 'Flightdeck', 'flightdeck.db'))).toBe(true)
    legacy.close()
    expect(readOrigins(join(parent, 'Flightdeck', 'flightdeck.db'))).toEqual(['EGLL', 'KJFK'])
  })

  it('copies the cloud-sync session and conflict log alongside the database', () => {
    parent = mkdtempSync(join(tmpdir(), 'winglog-legacy-test-'))
    const legacy = seedLegacy()
    writeFileSync(join(parent, 'Flightdeck', 'cloud-session.enc'), 'encrypted-bytes')
    writeFileSync(join(parent, 'Flightdeck', 'sync-conflicts.log'), 'a conflict')

    const userData = join(parent, 'WingLog')
    const result = migrateLegacyUserData(userData, join(userData, 'winglog.db'))

    expect(result.sidecars).toEqual(['cloud-session.enc', 'sync-conflicts.log'])
    expect(existsSync(join(userData, 'cloud-session.enc'))).toBe(true)
    legacy.close()
  })

  it('also finds the lower-case dev-mode directory name', () => {
    parent = mkdtempSync(join(tmpdir(), 'winglog-legacy-test-'))
    const legacy = seedLegacy('flightdeck', ['LFPG'])

    const userData = join(parent, 'winglog')
    const dbPath = join(userData, 'winglog.db')
    const result = migrateLegacyUserData(userData, dbPath)

    expect(result.migrated).toBe(true)
    expect(readOrigins(dbPath)).toEqual(['LFPG'])
    legacy.close()
  })

  it('never overwrites an existing database', () => {
    parent = mkdtempSync(join(tmpdir(), 'winglog-legacy-test-'))
    const legacy = seedLegacy()

    const userData = join(parent, 'WingLog')
    mkdirSync(userData, { recursive: true })
    const dbPath = join(userData, 'winglog.db')
    const existing = new Database(dbPath)
    existing.exec('create table flight (id integer primary key, origin text not null)')
    existing.prepare('insert into flight (origin) values (?)').run('EIDW')
    existing.close()

    const result = migrateLegacyUserData(userData, dbPath)

    expect(result.migrated).toBe(false)
    expect(readOrigins(dbPath)).toEqual(['EIDW'])
    legacy.close()
  })

  it('is a no-op on a fresh install with no legacy directory', () => {
    parent = mkdtempSync(join(tmpdir(), 'winglog-legacy-test-'))
    const userData = join(parent, 'WingLog')

    const result = migrateLegacyUserData(userData, join(userData, 'winglog.db'))

    expect(result).toEqual({ migrated: false, sidecars: [] })
    expect(existsSync(join(userData, 'winglog.db'))).toBe(false)
  })
})
