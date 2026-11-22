/**
 * Migration 0048 (drizzle/0048_rebuild_navdata_procedure_leg.sql): `navdata_procedure_leg` gets its three origin (recommended navaid) columns whatever shape
 * the database is in. 1.7.2 shipped those columns as its own migration 0041 (dated before v2's), which v2 leaves out of its journal, so three databases
 * reach 0048: a fresh one, a v2 development one already at 0047 (no columns), and a 1.7.2 one that upgrades (columns already there, and its 0041 applied).
 * Run through the real `migrateDb` and the real migration files, against databases holding child rows FK'd to what the migrations rebuild.
 * winglog-backend docs/plans/fd-leg-dme-navaid.md, "Into v2".
 */
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDb } from './client'
import { migrateDb } from './migrate'
import { fdLegsLackNavaid } from './navdata-repo'

const REAL_DIR = join(process.cwd(), 'drizzle')
const LEG_COLUMNS_BEFORE = [
  'id',
  'procedure_id',
  'runway_ident',
  'transition_name',
  'seq',
  'type',
  'fix_ident',
  'fix_type',
  'fix_latitude',
  'fix_longitude',
  'turn_direction',
  'course_deg',
  'altitude1',
  'altitude2',
  'speed_limit',
  'route_distance_m'
]
const ORIGIN_COLUMNS = ['origin_ident', 'origin_latitude', 'origin_longitude']
const FD_LEG_TYPE = 10
// 1.7.2's own migration 0041 (the `fixes` branch, commit 0db847dd), kept here as the fixture of what a 1.7.2 database ran. v2's journal does not have it.
const FD_RELEASE_TAG = '0041_lumpy_living_mummy'
const FD_RELEASE_WHEN = 1793750000000
const FD_RELEASE_SQL = [
  'ALTER TABLE `navdata_procedure_leg` ADD `origin_ident` text;',
  'ALTER TABLE `navdata_procedure_leg` ADD `origin_latitude` real;',
  'ALTER TABLE `navdata_procedure_leg` ADD `origin_longitude` real;'
].join('--> statement-breakpoint\n')

type Row = Record<string, unknown>
type Journal = { entries: { idx: number; when: number; tag: string }[] }

const number = (name: string): number => Number(/(\d{4})_/.exec(name)?.[1])
const readJournal = (dir: string): Journal =>
  JSON.parse(readFileSync(join(dir, 'meta', '_journal.json'), 'utf-8')) as Journal

/** A migrations folder holding the real migrations up to and including `lastNumber` (v2's journal before this change when 47; 1.7.2's when 40, plus its 0041). */
function buildFolder(dir: string, lastNumber: number, withReleaseFd: boolean): void {
  mkdirSync(join(dir, 'meta'), { recursive: true })
  for (const file of readdirSync(REAL_DIR)) {
    if (file.endsWith('.sql') && number(file) <= lastNumber)
      copyFileSync(join(REAL_DIR, file), join(dir, file))
  }
  const journal = readJournal(REAL_DIR)
  journal.entries = journal.entries.filter((entry) => number(entry.tag) <= lastNumber)
  if (withReleaseFd) {
    writeFileSync(join(dir, `${FD_RELEASE_TAG}.sql`), FD_RELEASE_SQL)
    journal.entries.push({ idx: 41, when: FD_RELEASE_WHEN, tag: FD_RELEASE_TAG })
  }
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify(journal, null, 2))
}

describe('migration 0048: the FD navaid columns on navdata_procedure_leg', () => {
  let dir: string
  let dbPath: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'winglog-fd-navaid-'))
    dbPath = join(dir, 'winglog.db')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const open = (): Database.Database => createDb(dbPath).sqlite
  const columns = (sqlite: Database.Database, table: string): string[] =>
    (sqlite.pragma(`table_info(${table})`) as { name: string }[]).map((column) => column.name)
  const legRows = (sqlite: Database.Database, names: string[]): Row[] =>
    sqlite.prepare(`SELECT ${names.join(', ')} FROM navdata_procedure_leg ORDER BY id`).all() as Row[]

  /** What the user owns: an aircraft, flights, and the landing, track point and invoice rows FK'd to them. */
  function seedUserRows(sqlite: Database.Database): void {
    sqlite
      .prepare(
        `INSERT INTO aircraft (id, registration, icao_type, created_at) VALUES (1, 'G-REAL', 'A320', '2026-01-01')`
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO flight (id, aircraft_id, status, dep_icao, arr_icao, created_at) VALUES (1, 1, 'completed', 'EGLL', 'EGCC', '2026-01-01')`
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO flight (id, aircraft_id, status, dep_icao, arr_icao, created_at) VALUES (2, 1, 'completed', 'EGCC', 'EGLL', '2026-01-02')`
      )
      .run()
    for (let second = 0; second < 5; second++) {
      sqlite
        .prepare(
          `INSERT INTO track_point (flight_id, ts_utc, latitude, longitude, altitude_m, altitude_agl_m, indicated_airspeed_ms, ground_speed_ms, vertical_speed_ms, heading_true_deg, pitch_deg, bank_deg, phase, on_ground, fuel_kg)
           VALUES (1, ?, 53.35, -2.27, 100, 50, 60, 60, 0, 90, 0, 0, 'cruise', 0, 5000)`
        )
        .run(`2026-01-01T00:00:0${second}Z`)
    }
    sqlite
      .prepare(
        `INSERT INTO landing (flight_id, seq, icao, touchdown_ts_utc, vertical_speed_ms, g_force, pitch_deg, bank_deg, heading_true_deg, indicated_airspeed_ms, ground_speed_ms, wind_speed_ms, wind_direction_deg, headwind_ms, crosswind_ms, crab_deg, touchdown_source)
         VALUES (1, 1, 'EGCC', '2026-01-01T01:00:00Z', -1, 1.2, 1, 0, 90, 60, 60, 3, 90, 2, 1, 1, 'derived')`
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO flight_invoice (flight_id, service_group, receipt_id, issued_utc, icao, tail, source_html_path, receipt_json)
         VALUES (1, 'fuel', 'R-1', '2026-01-01T00:30:00Z', 'EGLL', 'G-REAL', 'r.html', '{}')`
      )
      .run()
  }

  /** Cached procedures at two airports with legs, including FD legs; with origin values only when the database's shape has the columns. */
  function seedNavdata(sqlite: Database.Database, withOrigin: boolean): void {
    const procedure = sqlite.prepare(
      `INSERT INTO navdata_procedure (id, icao, kind, identifier, runway_idents_json, source, fetched_at) VALUES (?, ?, 'sid', ?, '["05L"]', 'sim', '2026-11-01T10:00:00Z')`
    )
    procedure.run(1, 'EGCC', 'DESI1S')
    procedure.run(2, 'EGLL', 'OCK7J')
    const leg = sqlite.prepare(
      `INSERT INTO navdata_procedure_leg (id, procedure_id, runway_ident, transition_name, seq, type, fix_ident, fix_type, fix_latitude, fix_longitude, turn_direction, course_deg, altitude1, altitude2, speed_limit, route_distance_m)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, 0, ?)`
    )
    leg.run(1, 1, '05L', null, 1, 4, 'DE05L', 'R', 53.3, -2.28, 51, 70, 0)
    leg.run(2, 1, '05L', null, 2, 7, 'D051L', 'W', 53.4, -2.2, 51, 1219, 0)
    leg.run(3, 1, '05L', null, 3, FD_LEG_TYPE, 'D051L', 'W', 53.4, -2.2, 51, 1219, 25928)
    leg.run(4, 1, null, 'TNT', 4, 7, 'DESIG', 'W', 53.5, -2.1, 0, 1500, 0)
    leg.run(5, 2, null, null, 1, FD_LEG_TYPE, 'OCK', 'V', 51.3, -0.45, 120, 900, 12964)
    if (withOrigin) {
      const origin = sqlite.prepare(
        `UPDATE navdata_procedure_leg SET origin_ident = ?, origin_latitude = ?, origin_longitude = ? WHERE id = ?`
      )
      origin.run('MCT', 53.36, -2.26, 3)
      origin.run('OCK', 51.3, -0.45, 5)
      origin.run('', 0, 0, 1)
    }
  }

  /** The assertions every path shares: nothing lost, nothing dangling, the cached legs flagged to be fetched again. */
  function expectUpgraded(sqlite: Database.Database, userRowsBefore: Row[]): void {
    expect(columns(sqlite, 'navdata_procedure_leg')).toEqual([...LEG_COLUMNS_BEFORE, ...ORIGIN_COLUMNS])
    expect(sqlite.pragma('foreign_key_check')).toEqual([])
    expect(sqlite.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(userRows(sqlite)).toEqual(userRowsBefore)
    expect(
      sqlite
        .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE name LIKE '%\\_\\_new\\_%' ESCAPE '\\'`)
        .get()
    ).toEqual({ n: 0 })
    expect(
      sqlite
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'navdata_procedure_leg' AND name NOT LIKE 'sqlite_%'`
        )
        .all()
    ).toEqual([{ name: 'navdata_procedure_leg_procedure_id_idx' }])
  }

  /** The user's own rows, as a comparable snapshot (the flight's uuid and updated_at are set by migrations 0042 to 0047, so they are read after the fact too). */
  function userRows(sqlite: Database.Database): Row[] {
    return [
      sqlite.prepare('SELECT id, registration, icao_type FROM aircraft ORDER BY id').all(),
      sqlite.prepare('SELECT id, aircraft_id, status, dep_icao, arr_icao FROM flight ORDER BY id').all(),
      sqlite.prepare('SELECT flight_id, ts_utc, latitude, fuel_kg FROM track_point ORDER BY id').all(),
      sqlite.prepare('SELECT flight_id, seq, icao, touchdown_ts_utc FROM landing ORDER BY id').all(),
      sqlite.prepare('SELECT flight_id, receipt_id FROM flight_invoice ORDER BY id').all()
    ] as unknown as Row[]
  }

  it('gives a fresh database the three origin columns, and an index, and nothing else on the table', () => {
    migrateDb(dbPath, REAL_DIR)
    const sqlite = open()
    expect(columns(sqlite, 'navdata_procedure_leg')).toEqual([...LEG_COLUMNS_BEFORE, ...ORIGIN_COLUMNS])
    expect(sqlite.pragma('foreign_key_check')).toEqual([])
    expect(
      sqlite
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'navdata_procedure_leg' AND name NOT LIKE 'sqlite_%'`
        )
        .all()
    ).toEqual([{ name: 'navdata_procedure_leg_procedure_id_idx' }])
    sqlite.close()
  })

  it('upgrades a v2 development database already at 0047 (no origin columns), keeping every user row and cached leg, and flags the cached FD legs to be fetched again', () => {
    const v2Dir = join(dir, 'v2-before')
    buildFolder(v2Dir, 47, false)
    expect(readJournal(v2Dir).entries.at(-1)?.tag).toBe('0047_iso_updated_at')
    const baseline = createDb(dbPath)
    migrate(baseline.db, { migrationsFolder: v2Dir })
    expect(columns(baseline.sqlite, 'navdata_procedure_leg').sort()).toEqual([...LEG_COLUMNS_BEFORE].sort())
    seedUserRows(baseline.sqlite)
    seedNavdata(baseline.sqlite, false)
    baseline.sqlite.close()

    const before = open()
    const userBefore = userRows(before)
    const legsBefore = legRows(before, LEG_COLUMNS_BEFORE)
    expect(legsBefore).toHaveLength(5)
    before.close()

    expect(() => migrateDb(dbPath, REAL_DIR)).not.toThrow()

    const { sqlite, db } = createDb(dbPath)
    expectUpgraded(sqlite, userBefore)
    expect(legRows(sqlite, LEG_COLUMNS_BEFORE)).toEqual(legsBefore)
    expect(
      legRows(sqlite, ORIGIN_COLUMNS).every((row) => Object.values(row).every((value) => value === null))
    ).toBe(true)
    expect(fdLegsLackNavaid(db, 'EGCC')).toBe(true)
    expect(fdLegsLackNavaid(db, 'EGLL')).toBe(true)
    // The next leg cached gets an id after the existing ones: the table's autoincrement carried over.
    const next = sqlite
      .prepare(
        `INSERT INTO navdata_procedure_leg (procedure_id, seq, type, fix_latitude, fix_longitude, turn_direction, course_deg, altitude1, altitude2, speed_limit) VALUES (1, 9, 7, 0, 0, 0, 0, 0, 0, 0)`
      )
      .run()
    expect(Number(next.lastInsertRowid)).toBe(6)
    sqlite.close()
  })

  it('upgrades a 1.7.2 database (origin columns already there, its own 0041 applied): v2 migrations 0041 to 0048 all run, no duplicate column, user rows kept', () => {
    const releaseDir = join(dir, 'release-1.7.2')
    buildFolder(releaseDir, 40, true)
    const baseline = createDb(dbPath)
    migrate(baseline.db, { migrationsFolder: releaseDir })
    // Columns added by ALTER sit after the original ones, so the shape is compared as a set; only the rebuilt table has them in schema order.
    expect(columns(baseline.sqlite, 'navdata_procedure_leg').sort()).toEqual(
      [...LEG_COLUMNS_BEFORE, ...ORIGIN_COLUMNS].sort()
    )
    expect(
      baseline.sqlite.prepare('SELECT count(*) AS n FROM sqlite_master WHERE name = ?').get('sync_change')
    ).toEqual({ n: 0 })
    seedUserRows(baseline.sqlite)
    seedNavdata(baseline.sqlite, true)
    baseline.sqlite.close()

    const before = open()
    const userBefore = userRows(before)
    const legsBefore = legRows(before, LEG_COLUMNS_BEFORE)
    expect(legRows(before, ORIGIN_COLUMNS).filter((row) => row.origin_ident === 'MCT')).toHaveLength(1)
    before.close()

    expect(() => migrateDb(dbPath, REAL_DIR)).not.toThrow()

    const { sqlite, db } = createDb(dbPath)
    expectUpgraded(sqlite, userBefore)
    expect(legRows(sqlite, LEG_COLUMNS_BEFORE)).toEqual(legsBefore)
    // Every v2 migration ran: its tables exist, and the journal's last time is v2's 0048.
    for (const table of ['sync_change', 'sync_deferred_row', 'gsx_routine', 'lan_device']) {
      expect(sqlite.prepare('SELECT count(*) AS n FROM sqlite_master WHERE name = ?').get(table)).toEqual({
        n: 1
      })
    }
    const applied = sqlite
      .prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at')
      .all() as { created_at: number }[]
    const lastWhen = readJournal(REAL_DIR).entries.at(-1)?.when
    expect(applied.at(-1)?.created_at).toBe(lastWhen)
    // 1.7.2's origin values are dropped by the rebuild (SQL cannot copy a column that is absent in the other shape), so the legs are fetched again once.
    expect(
      legRows(sqlite, ORIGIN_COLUMNS).every((row) => Object.values(row).every((value) => value === null))
    ).toBe(true)
    expect(fdLegsLackNavaid(db, 'EGCC')).toBe(true)
    sqlite.close()
  })

  it('keeps the migration chain sound: indexes and tags are in step, times strictly rise, and the newest snapshot has the origin columns', () => {
    const { entries } = readJournal(REAL_DIR)
    entries.forEach((entry, position) => {
      expect(entry.idx).toBe(position)
      expect(number(entry.tag)).toBe(position)
      if (position > 0) expect(entry.when).toBeGreaterThan(entries[position - 1].when)
    })
    // 1.7.2's 0041 is dated before v2's first migration after 0040, so a 1.7.2 database that upgrades still runs all of v2's.
    expect(entries[41].when).toBeGreaterThan(FD_RELEASE_WHEN)
    expect(
      readdirSync(REAL_DIR)
        .filter((file) => file.endsWith('.sql'))
        .map(number)
    ).toEqual(entries.map((_, position) => position))
    const last = entries.at(-1)?.tag ?? ''
    const snapshot = JSON.parse(
      readFileSync(
        join(REAL_DIR, 'meta', `${number(last).toString().padStart(4, '0')}_snapshot.json`),
        'utf-8'
      )
    ) as {
      tables: Record<string, { columns: Record<string, unknown> }>
    }
    for (const column of ORIGIN_COLUMNS)
      expect(snapshot.tables.navdata_procedure_leg.columns).toHaveProperty(column)
  })
})
