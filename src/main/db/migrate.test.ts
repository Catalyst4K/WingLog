import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createDb } from './client'
import { migrateDb } from './migrate'

// Regression coverage for the packaged-app bug where migrateDb's cwd-relative default
// silently found no migrations at all once launched outside a terminal with cwd=project
// root — see electron-builder.yml and src/main/index.ts for the fix (an explicit,
// app.getAppPath()-derived migrationsFolder). Both call shapes need to keep working:
// scripts/db-migrate.ts and every other test rely on the cwd-relative default.
describe('migrateDb', () => {
  let tempDir: string

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  })

  it('applies migrations using the cwd-relative default', () => {
    migrateDb(':memory:')
  })

  it('applies migrations using an explicit absolute migrationsFolder, as the packaged app does', () => {
    migrateDb(':memory:', join(process.cwd(), 'drizzle'))
  })

  it('leaves a usable, persisted database behind with the explicit-path call shape', () => {
    // migrateDb closes its own sqlite handle, so open a fresh one against the same file
    // to confirm the schema actually landed rather than just not throwing — a real file,
    // since a fresh :memory: connection would be a distinct, unrelated database.
    tempDir = mkdtempSync(join(tmpdir(), 'winglog-migrate-test-'))
    const dbPath = join(tempDir, 'winglog.db')
    migrateDb(dbPath, join(process.cwd(), 'drizzle'))
    const { sqlite, db } = createDb(dbPath)
    expect(() => db.run(`select 1 from aircraft limit 1`)).not.toThrow()
    sqlite.close()
  })

  // Regression for a real failure on Callum's own installed build (2026-09-17):
  // "WingLog failed to start" — DrizzleError on `DROP TABLE 'flight'` — the moment a real
  // database with actual flight history upgraded through migration 0024
  // (flight.aircraft_id -> nullable, for free-flight-tracking.md's "don't add to fleet"
  // option). Root cause: 0024 recreates the flight table, which needs
  // `PRAGMA foreign_keys=OFF` first, but drizzle's own migrator (sqlite-core/dialect.js)
  // wraps every pending migration's SQL in one `BEGIN`/`COMMIT` it opens itself — and
  // SQLite treats that pragma as a no-op once a transaction is already open. createDb()
  // always leaves foreign_keys ON for normal app use, so with real child rows in
  // landing/track_point still FK'd to flight.id (any real user's database, but not the
  // earlier verification pass that missed this — an empty-ish DB with no child rows never
  // hits the constraint), the DROP TABLE failed for real. Fixed by toggling the pragma in
  // migrateDb itself, outside of migrate()'s own transaction. This test reproduces the
  // exact shape: a database already migrated through 0023 (the last migration before
  // 0024), with real landing/track_point rows, then upgraded via the real migrations
  // folder — would throw `SqliteError: FOREIGN KEY constraint failed` without the fix.
  it('upgrades a real pre-existing database (with landing/track_point rows already FK-referencing flight) through migration 0024 without error', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'winglog-migrate-0024-test-'))
    const dbPath = join(tempDir, 'winglog.db')

    // A migrations folder containing everything except 0024 — brings a fresh DB up to
    // exactly the schema shape a real pre-existing user database was in before this
    // migration existed.
    const realDrizzleDir = join(process.cwd(), 'drizzle')
    const baselineDir = join(tempDir, 'drizzle-baseline')
    mkdirSync(join(baselineDir, 'meta'), { recursive: true })
    for (const f of readdirSync(realDrizzleDir)) {
      if (f.endsWith('.sql') && !f.startsWith('0024_')) {
        copyFileSync(join(realDrizzleDir, f), join(baselineDir, f))
      }
    }
    const journal = JSON.parse(readFileSync(join(realDrizzleDir, 'meta', '_journal.json'), 'utf-8'))
    journal.entries = journal.entries.filter((e: { tag: string }) => !e.tag.startsWith('0024_'))
    writeFileSync(join(baselineDir, 'meta', '_journal.json'), JSON.stringify(journal, null, 2))

    const baseline = createDb(dbPath)
    migrate(baseline.db, { migrationsFolder: baselineDir })
    baseline.sqlite
      .prepare(`INSERT INTO aircraft (id, registration, icao_type, created_at) VALUES (1, 'G-REAL', 'A320', '2026-01-01')`)
      .run()
    baseline.sqlite
      .prepare(
        `INSERT INTO flight (id, aircraft_id, status, dep_icao, arr_icao, created_at) VALUES (1, 1, 'completed', 'EGLL', 'VHHH', '2026-01-01')`
      )
      .run()
    // Real child rows, both FK'd to flight.id — the case the earlier verification pass
    // (an empty-ish DB) missed entirely.
    baseline.sqlite
      .prepare(
        `INSERT INTO track_point (flight_id, ts_utc, latitude, longitude, altitude_m, altitude_agl_m, indicated_airspeed_ms, ground_speed_ms, vertical_speed_ms, heading_true_deg, pitch_deg, bank_deg, phase, on_ground, fuel_kg)
         VALUES (1, '2026-01-01T00:00:00Z', 1, 1, 100, 50, 50, 50, 0, 90, 0, 0, 'cruise', 0, 1000)`
      )
      .run()
    baseline.sqlite
      .prepare(
        `INSERT INTO landing (flight_id, seq, icao, touchdown_ts_utc, vertical_speed_ms, g_force, pitch_deg, bank_deg, heading_true_deg, indicated_airspeed_ms, ground_speed_ms, wind_speed_ms, wind_direction_deg, headwind_ms, crosswind_ms, crab_deg, touchdown_source)
         VALUES (1, 1, 'VHHH', '2026-01-01T01:00:00Z', -1, 1.2, 1, 0, 90, 60, 60, 3, 90, 2, 1, 1, 'derived')`
      )
      .run()
    baseline.sqlite.close()

    // The real upgrade path a real installed build hits on launch — would throw without
    // the migrate.ts fix.
    expect(() => migrateDb(dbPath, realDrizzleDir)).not.toThrow()

    const { sqlite } = createDb(dbPath)
    const flightRow = sqlite.prepare('select aircraft_id from flight where id = 1').get() as { aircraft_id: number }
    expect(flightRow.aircraft_id).toBe(1)
    expect(sqlite.prepare('select 1 from landing where flight_id = 1').get()).toBeDefined()
    expect(sqlite.prepare('select 1 from track_point where flight_id = 1').get()).toBeDefined()
    // Normal runtime enforcement is restored after migrateDb closes its own connection.
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1)
    sqlite.close()
  })

  // Migration 0027 (aircraft.retired_at) is a plain ADD COLUMN, but per CLAUDE.md every
  // migration gets checked against a database with real rows — an aircraft with a flight
  // already FK'd to it must survive with retired_at defaulting to NULL (i.e. still active).
  it('upgrades a populated database through migration 0027, leaving existing aircraft active with their flights', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'winglog-migrate-0027-test-'))
    const dbPath = join(tempDir, 'winglog.db')
    const realDrizzleDir = join(process.cwd(), 'drizzle')
    const baselineDir = join(tempDir, 'drizzle-baseline')
    mkdirSync(join(baselineDir, 'meta'), { recursive: true })
    for (const f of readdirSync(realDrizzleDir)) {
      if (f.endsWith('.sql') && !f.startsWith('0027_')) copyFileSync(join(realDrizzleDir, f), join(baselineDir, f))
    }
    const journal = JSON.parse(readFileSync(join(realDrizzleDir, 'meta', '_journal.json'), 'utf-8'))
    journal.entries = journal.entries.filter((e: { tag: string }) => !e.tag.startsWith('0027_'))
    writeFileSync(join(baselineDir, 'meta', '_journal.json'), JSON.stringify(journal, null, 2))

    const baseline = createDb(dbPath)
    migrate(baseline.db, { migrationsFolder: baselineDir })
    baseline.sqlite
      .prepare(`INSERT INTO aircraft (id, registration, icao_type, created_at) VALUES (1, 'G-REAL', 'A320', '2026-01-01')`)
      .run()
    baseline.sqlite
      .prepare(
        `INSERT INTO flight (id, aircraft_id, status, dep_icao, arr_icao, created_at) VALUES (1, 1, 'completed', 'EGLL', 'VHHH', '2026-01-01')`
      )
      .run()
    baseline.sqlite.close()

    expect(() => migrateDb(dbPath, realDrizzleDir)).not.toThrow()

    const { sqlite } = createDb(dbPath)
    expect(sqlite.prepare('select retired_at from aircraft where id = 1').get()).toEqual({ retired_at: null })
    expect(sqlite.prepare('select aircraft_id from flight where id = 1').get()).toEqual({ aircraft_id: 1 })
    sqlite.close()
  })
})
