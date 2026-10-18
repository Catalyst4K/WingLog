import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from './schema'

/** What a page filters on, and the index that must serve it: a SCAN reads the whole table and slows with every flight flown. */
const FILTERS: { what: string; sql: string; index: string }[] = [
  {
    what: "a flight's track points",
    sql: 'SELECT * FROM track_point WHERE flight_id = 1 ORDER BY id',
    index: 'track_point_flight_id_idx'
  },
  {
    what: "an aircraft's flights",
    sql: 'SELECT * FROM flight WHERE aircraft_id = 1',
    index: 'flight_aircraft_id_idx'
  },
  {
    what: 'completed flights',
    sql: "SELECT * FROM flight WHERE status = 'completed'",
    index: 'flight_status_idx'
  },
  {
    what: "a flight's invoices",
    sql: 'SELECT * FROM flight_invoice WHERE flight_id = 1',
    index: 'flight_invoice_flight_id_idx'
  },
  {
    what: "a flight's landings",
    sql: 'SELECT * FROM landing WHERE flight_id = 1',
    index: 'landing_flight_id_seq_idx'
  },
  {
    what: "an airport's runways",
    sql: "SELECT * FROM navdata_runway WHERE icao = 'EGLL'",
    index: 'navdata_runway_icao_idx'
  },
  {
    what: "an airport's procedures of one kind",
    sql: "SELECT * FROM navdata_procedure WHERE icao = 'EGLL' AND kind = 'sid'",
    index: 'navdata_procedure_icao_kind_idx'
  },
  {
    what: "a procedure's legs",
    sql: 'SELECT * FROM navdata_procedure_leg WHERE procedure_id = 1',
    index: 'navdata_procedure_leg_procedure_id_idx'
  },
  {
    what: "an airport's taxi network",
    sql: "SELECT * FROM navdata_taxi_segment WHERE icao = 'RKSI'",
    index: 'navdata_taxi_segment_icao_idx'
  },
  {
    what: "an airport's stands",
    sql: "SELECT * FROM navdata_stand WHERE icao = 'VHHH'",
    index: 'navdata_stand_icao_idx'
  }
]

describe('the indexes the pages rely on', () => {
  let sqlite: Database.Database

  beforeEach(() => {
    sqlite = new Database(':memory:')
    migrate(drizzle(sqlite, { schema }), { migrationsFolder: 'drizzle' })
  })

  it.each(FILTERS)('serves $what from $index, not a full table scan', ({ sql, index }) => {
    const plan = (sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
      .map((p) => p.detail)
      .join('; ')
    expect(plan).toContain(`USING INDEX ${index}`)
    expect(plan).not.toMatch(/\bSCAN\b/)
  })

  it('keeps the rows of a database that already holds data when the indexes arrive', () => {
    // Migrate to just before the index migration, add a flight with its child rows, then apply the rest.
    const journal = JSON.parse(readFileSync(join('drizzle', 'meta', '_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string }[]
    }
    const indexMigration = journal.entries.find((e) => e.tag.startsWith('0032_'))
    expect(indexMigration).toBeDefined()
    const before = mkdtempSync(join(tmpdir(), 'winglog-before-indexes-'))
    try {
      mkdirSync(join(before, 'meta'))
      const kept = journal.entries.filter((e) => e.idx < (indexMigration?.idx ?? 0))
      for (const e of kept) copyFileSync(join('drizzle', `${e.tag}.sql`), join(before, `${e.tag}.sql`))
      writeFileSync(join(before, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }))

      const old = new Database(':memory:')
      old.pragma('foreign_keys = ON')
      const db = drizzle(old, { schema })
      migrate(db, { migrationsFolder: before })
      expect(
        old.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'track_point_flight_id_idx'").get()
      ).toEqual({ n: 0 })
      old.exec("INSERT INTO aircraft (registration, icao_type) VALUES ('G-ABCD', 'A320')")
      const aircraftId = (old.prepare('SELECT id FROM aircraft').get() as { id: number }).id
      old.exec(
        `INSERT INTO flight (aircraft_id, dep_icao, arr_icao, status) VALUES (${aircraftId}, 'EGLL', 'EGCC', 'completed')`
      )
      const flightId = (old.prepare('SELECT id FROM flight').get() as { id: number }).id
      old.exec(
        `INSERT INTO track_point (flight_id, ts_utc, latitude, longitude, altitude_m, altitude_agl_m, indicated_airspeed_ms, ground_speed_ms, vertical_speed_ms, heading_true_deg, pitch_deg, bank_deg, phase, on_ground, fuel_kg) VALUES (${flightId}, 't', 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 'taxi', 1, 11)`
      )

      migrate(db, { migrationsFolder: 'drizzle' })
      expect(old.prepare('SELECT COUNT(*) AS n FROM flight').get()).toEqual({ n: 1 })
      expect(old.prepare('SELECT COUNT(*) AS n FROM track_point').get()).toEqual({ n: 1 })
      expect(
        old.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'track_point_flight_id_idx'").get()
      ).toEqual({ n: 1 })
      expect(old.pragma('integrity_check', { simple: true })).toBe('ok')
      expect(old.pragma('foreign_key_check')).toEqual([])
    } finally {
      rmSync(before, { recursive: true, force: true })
    }
  })
})
