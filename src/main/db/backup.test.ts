import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { backupDatabaseOnLaunch } from './backup'

describe('backupDatabaseOnLaunch', () => {
  let parent: string

  function seedDb(dbPath: string, rows: string[]): void {
    const sqlite = new Database(dbPath)
    sqlite.pragma('journal_mode = WAL')
    // Never checkpoint automatically, so committed rows stay in the -wal file — the case
    // VACUUM INTO has to handle correctly (matches legacy-userdata.test.ts's rationale).
    sqlite.pragma('wal_autocheckpoint = 0')
    sqlite.exec('create table flight (id integer primary key, origin text not null)')
    for (const origin of rows) {
      sqlite.prepare('insert into flight (origin) values (?)').run(origin)
    }
    sqlite.close()
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

  it('is a no-op on a fresh install with no database yet', () => {
    parent = mkdtempSync(join(tmpdir(), 'winglog-backup-test-'))
    const backupsDir = join(parent, 'backups')

    backupDatabaseOnLaunch(join(parent, 'winglog.db'), backupsDir)

    expect(existsSync(backupsDir)).toBe(false)
  })

  it('snapshots the database, including rows still sitting in the WAL', () => {
    parent = mkdtempSync(join(tmpdir(), 'winglog-backup-test-'))
    const dbPath = join(parent, 'winglog.db')
    seedDb(dbPath, ['EGLL', 'KJFK'])
    const backupsDir = join(parent, 'backups')

    backupDatabaseOnLaunch(dbPath, backupsDir)

    const backups = readdirSync(backupsDir)
    expect(backups).toHaveLength(1)
    expect(readOrigins(join(backupsDir, backups[0]))).toEqual(['EGLL', 'KJFK'])
  })

  it('keeps only the newest N backups', () => {
    parent = mkdtempSync(join(tmpdir(), 'winglog-backup-test-'))
    const dbPath = join(parent, 'winglog.db')
    seedDb(dbPath, ['EGLL'])
    const backupsDir = join(parent, 'backups')

    // Pre-existing backups, deliberately dated well before "now" so a fresh snapshot
    // (taken below) always sorts after all three — filename order is what pruning relies
    // on, and real calls in a fast test run can collide on the same millisecond.
    mkdirSync(backupsDir, { recursive: true })
    for (const suffix of ['20260101T000000000Z', '20260102T000000000Z', '20260103T000000000Z']) {
      writeFileSync(join(backupsDir, `winglog-${suffix}.db`), '')
    }

    backupDatabaseOnLaunch(dbPath, backupsDir, 2)

    // Of the four total (three pre-existing plus the fresh one just taken), only the
    // newest two survive: the 01-03 pre-existing one and the fresh snapshot.
    const backups = readdirSync(backupsDir).sort()
    expect(backups).toHaveLength(2)
    expect(backups[0]).toBe('winglog-20260103T000000000Z.db')
    expect(backups).not.toContain('winglog-20260101T000000000Z.db')
    expect(backups).not.toContain('winglog-20260102T000000000Z.db')
  })
})
