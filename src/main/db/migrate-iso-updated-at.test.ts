/**
 * Migration 0047 (drizzle/0047_iso_updated_at.sql): an `updated_at` in SQLite's `current_timestamp` form (`2026-09-01 16:50:31`), which migration 0010's
 * backfill left on every row older than it, becomes the ISO time the cloud and the twins accept. Run through the real `migrateDb`, against a database
 * that was at 0046 and holds child rows FK'd to the rows it rewrites.
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

const MIGRATION = 47
const OLD = '2026-09-01 16:50:31'
const OLD_ISO = '2026-09-01T16:50:31.000Z'
const ISO_ALREADY = '2026-10-05T09:30:00.123Z'

/** A migrations folder holding only the migrations before 0047: what a real database was at before it. */
function buildBaselineFolder(realDir: string, baselineDir: string): void {
  mkdirSync(join(baselineDir, 'meta'), { recursive: true })
  const number = (name: string): number => Number(/(\d{4})_/.exec(name)?.[1])
  for (const file of readdirSync(realDir)) {
    if (file.endsWith('.sql') && number(file) < MIGRATION)
      copyFileSync(join(realDir, file), join(baselineDir, file))
  }
  const journal = JSON.parse(readFileSync(join(realDir, 'meta', '_journal.json'), 'utf-8')) as {
    entries: { tag: string }[]
  }
  journal.entries = journal.entries.filter((entry) => number(entry.tag) < MIGRATION)
  writeFileSync(join(baselineDir, 'meta', '_journal.json'), JSON.stringify(journal, null, 2))
}

type Row = Record<string, unknown>

describe('migration 0047: updated_at in ISO form', () => {
  let dir: string
  let dbPath: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'winglog-iso-updated-at-'))
    dbPath = join(dir, 'winglog.db')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  /** A database at 0046 with old-form and ISO rows in every synced table, children FK'd to their flights, and some soft-deleted and NULL ones. */
  function seedBaseline(withOldRows: boolean): void {
    const realDir = join(process.cwd(), 'drizzle')
    const baselineDir = join(dir, 'baseline')
    buildBaselineFolder(realDir, baselineDir)
    const { sqlite, db } = createDb(dbPath)
    migrate(db, { migrationsFolder: baselineDir })
    const stamp = withOldRows ? OLD : ISO_ALREADY
    const aircraftRow = sqlite.prepare(
      `INSERT INTO aircraft (id, registration, icao_type, created_at, uuid, updated_at) VALUES (?, ?, 'A320', '2026-09-01 16:50:31', ?, ?)`
    )
    aircraftRow.run(1, 'G-OLD1', 'ac-old', stamp)
    aircraftRow.run(2, 'G-ISO1', 'ac-iso', ISO_ALREADY)
    const flightRow = sqlite.prepare(
      `INSERT INTO flight (id, aircraft_id, status, dep_icao, arr_icao, created_at, uuid, updated_at, deleted_at)
       VALUES (?, 1, 'completed', 'EGLL', 'EGCC', '2026-09-01 16:50:31', ?, ?, ?)`
    )
    flightRow.run(1, 'fl-old', stamp, null)
    flightRow.run(2, 'fl-deleted', stamp, '2026-09-02T10:00:00.000Z')
    flightRow.run(3, 'fl-iso', ISO_ALREADY, null)
    flightRow.run(4, 'fl-null', null, null)
    const landingRow = sqlite.prepare(
      `INSERT INTO landing (flight_id, seq, icao, touchdown_ts_utc, vertical_speed_ms, g_force, pitch_deg, bank_deg, heading_true_deg, indicated_airspeed_ms, ground_speed_ms, wind_speed_ms, wind_direction_deg, headwind_ms, crosswind_ms, crab_deg, touchdown_source, uuid, updated_at)
       VALUES (?, 1, 'EGCC', '2026-09-01T17:00:00.000Z', -1, 1.2, 1, 0, 90, 60, 60, 3, 90, 2, 1, 1, 'derived', ?, ?)`
    )
    landingRow.run(1, 'ld-old', stamp)
    landingRow.run(2, 'ld-deleted-flight', ISO_ALREADY)
    const invoiceRow = sqlite.prepare(
      `INSERT INTO flight_invoice (flight_id, service_group, receipt_id, issued_utc, icao, tail, source_html_path, receipt_json, uuid, updated_at)
       VALUES (?, 'fuel', ?, '2026-09-01T16:00:00.000Z', 'EGLL', 'G-OLD1', 'r.html', '{}', ?, ?)`
    )
    invoiceRow.run(1, 'R-1', 'inv-old', stamp)
    invoiceRow.run(3, 'R-2', 'inv-iso', ISO_ALREADY)
    sqlite
      .prepare(`INSERT INTO gsx_routine (uuid, kind, data, updated_at) VALUES ('rt-old', 'routine', '{}', ?)`)
      .run(stamp)
    sqlite.close()
  }

  const open = (): Database.Database => createDb(dbPath).sqlite
  const times = (sqlite: Database.Database, table: string): Row =>
    Object.fromEntries(
      (sqlite.prepare(`SELECT uuid, updated_at FROM ${table} ORDER BY uuid`).all() as Row[]).map((row) => [
        row.uuid,
        row.updated_at
      ])
    )
  const counters = (sqlite: Database.Database): Row[] =>
    sqlite.prepare('SELECT table_name, uuid FROM sync_change ORDER BY table_name, uuid').all() as Row[]

  it('rewrites every old-form time to ISO in every synced table, soft-deleted rows included, and leaves ISO and NULL times alone', () => {
    seedBaseline(true)
    migrateDb(dbPath, join(process.cwd(), 'drizzle'))
    const sqlite = open()
    expect(times(sqlite, 'aircraft')).toEqual({ 'ac-iso': ISO_ALREADY, 'ac-old': OLD_ISO })
    expect(times(sqlite, 'flight')).toEqual({
      'fl-deleted': OLD_ISO,
      'fl-iso': ISO_ALREADY,
      'fl-null': null,
      'fl-old': OLD_ISO
    })
    expect(times(sqlite, 'landing')).toEqual({ 'ld-deleted-flight': ISO_ALREADY, 'ld-old': OLD_ISO })
    expect(times(sqlite, 'flight_invoice')).toEqual({ 'inv-iso': ISO_ALREADY, 'inv-old': OLD_ISO })
    expect(times(sqlite, 'gsx_routine')).toEqual({ 'rt-old': OLD_ISO })
    sqlite.close()
  })

  it('changes nothing else: created_at, deleted_at, the other columns and every child row stay, and no foreign key is left dangling', () => {
    seedBaseline(true)
    const before = open()
    const flightsBefore = before
      .prepare('SELECT id, aircraft_id, status, created_at, deleted_at FROM flight ORDER BY id')
      .all()
    const landingsBefore = before
      .prepare('SELECT id, flight_id, touchdown_ts_utc FROM landing ORDER BY id')
      .all()
    const invoicesBefore = before
      .prepare('SELECT id, flight_id, receipt_id, issued_utc FROM flight_invoice ORDER BY id')
      .all()
    before.close()

    migrateDb(dbPath, join(process.cwd(), 'drizzle'))

    const after = open()
    expect(
      after.prepare('SELECT id, aircraft_id, status, created_at, deleted_at FROM flight ORDER BY id').all()
    ).toEqual(flightsBefore)
    expect(after.prepare('SELECT id, flight_id, touchdown_ts_utc FROM landing ORDER BY id').all()).toEqual(
      landingsBefore
    )
    expect(
      after.prepare('SELECT id, flight_id, receipt_id, issued_utc FROM flight_invoice ORDER BY id').all()
    ).toEqual(invoicesBefore)
    expect(after.prepare('SELECT created_at FROM aircraft WHERE id = 1').get()).toEqual({ created_at: OLD })
    expect(after.pragma('foreign_key_check')).toEqual([])
    after.close()
  })

  it('counts exactly the rewritten rows again in sync_change, so they are sent to the cloud and the twins', () => {
    seedBaseline(true)
    const before = open()
    const seqBefore = Object.fromEntries(
      (before.prepare('SELECT uuid, seq FROM sync_change').all() as { uuid: string; seq: number }[]).map(
        (row) => [row.uuid, row.seq]
      )
    )
    const maxBefore = Math.max(...Object.values(seqBefore))
    before.close()

    migrateDb(dbPath, join(process.cwd(), 'drizzle'))

    const after = open()
    const rows = after.prepare('SELECT uuid, seq FROM sync_change').all() as { uuid: string; seq: number }[]
    const moved = rows
      .filter((row) => row.seq > maxBefore)
      .map((row) => row.uuid)
      .sort()
    // Every old-form row (a soft-deleted one too), and nothing else: not the ISO rows, not the NULL one.
    expect(moved).toEqual(['ac-old', 'fl-deleted', 'fl-old', 'inv-old', 'ld-old', 'rt-old'])
    // The rest keep the counter they had, and no row was lost or doubled.
    for (const row of rows.filter((row) => row.seq <= maxBefore)) expect(row.seq).toBe(seqBefore[row.uuid])
    expect(rows).toHaveLength(Object.keys(seqBefore).length)
    after.close()
  })

  it('on a database with no old-form times changes nothing, and the counters stay as they were', () => {
    seedBaseline(false)
    const before = open()
    const countersBefore = before.prepare('SELECT table_name, uuid, seq FROM sync_change ORDER BY seq').all()
    const flightTimes = times(before, 'flight')
    before.close()

    migrateDb(dbPath, join(process.cwd(), 'drizzle'))

    const after = open()
    expect(after.prepare('SELECT table_name, uuid, seq FROM sync_change ORDER BY seq').all()).toEqual(
      countersBefore
    )
    expect(times(after, 'flight')).toEqual(flightTimes)
    expect(counters(after).length).toBe(countersBefore.length)
    after.close()
  })
})
