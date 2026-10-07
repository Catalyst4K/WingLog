/**
 * `npm run sim -- db-benchmark`: the baseline for winglog-backend docs/plans/robustness/performance-and-storage.md Part 1 (storage and
 * queries). Copies this machine's WingLog database to release/sim/db-benchmark/ (gitignored: personal data), opens the COPY, and
 * measures: bytes per table and index, rows, the OFP's share, and how long the pages' queries take, with their query plans. Writes
 * release/sim/db-benchmark/report.md. The live database is only read to make the copy. Not part of `npm test`.
 *
 * With WINGLOG_BENCH_MIGRATE=1 the copy first gets the migrations this build has (the live database has not been opened by this
 * build yet), and the report checks nothing was lost: row counts per table, the integrity check and the foreign key check.
 */
import { copyFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { it } from 'vitest'
import * as schema from '../../src/main/db/schema'
import { getFlight, listCompletedFlights, listFlights, getLogbookStats } from '../../src/main/db/flight-repo'
import { listAllLandings } from '../../src/main/db/landing-repo'
import {
  listCachedProcedures,
  listCachedRunways,
  listCachedStands,
  listCachedTaxiSegments
} from '../../src/main/db/navdata-repo'
import { listTrackPoints } from '../../src/main/db/track-point-repo'
import { userDataDir } from './local-data'
import { simOutputDir } from './report'

const RUNS = 5

/** The median of a few timings, milliseconds. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

/** Times `fn` a few times and returns the median in milliseconds, with what it returned the last time. */
function time<T>(fn: () => T): { ms: number; result: T } {
  const timings: number[] = []
  let result!: T
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now()
    result = fn()
    timings.push(performance.now() - start)
  }
  return { ms: median(timings), result }
}

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`

it('measures the database', () => {
  const source = join(userDataDir(), 'winglog.db')
  if (!existsSync(source)) throw new Error(`no database at ${source}`)
  const outDir = simOutputDir('db-benchmark')
  const copy = join(outDir, 'winglog-copy.db')
  copyFileSync(source, copy)

  const migrating = process.env.WINGLOG_BENCH_MIGRATE === '1'
  const sqlite = new Database(copy, { readonly: !migrating })
  const db = drizzle(sqlite, { schema })
  const countRows = (): Record<string, number> =>
    Object.fromEntries(
      (
        sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
          .all() as { name: string }[]
      )
        .filter((t) => !t.name.startsWith('__'))
        .map((t) => [
          t.name,
          (sqlite.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get() as { n: number }).n
        ])
    )
  const rowsBefore = countRows()
  const out: string[] = [
    '# Database baseline',
    '',
    `Copy of ${source} (${mb(statSync(copy).size)}), measured ${new Date().toISOString()}.`,
    ''
  ]

  // Storage: bytes per table and index from dbstat, rows per table.
  const pageSize = (sqlite.pragma('page_size', { simple: true }) as number) ?? 4096
  const pages = sqlite.pragma('page_count', { simple: true }) as number
  const free = sqlite.pragma('freelist_count', { simple: true }) as number
  if (migrating) {
    sqlite.pragma('foreign_keys = ON')
    const start = performance.now()
    migrate(db, { migrationsFolder: join(process.cwd(), 'drizzle') })
    const rowsAfter = countRows()
    const lost = Object.keys(rowsBefore).filter((t) => rowsAfter[t] !== rowsBefore[t])
    out.push(
      `Migrated the copy in ${(performance.now() - start).toFixed(0)} ms. Row counts per table ${lost.length === 0 ? 'unchanged' : 'CHANGED: ' + lost.join(', ')}; integrity_check: ${String(sqlite.pragma('integrity_check', { simple: true }))}; foreign_key_check: ${(sqlite.pragma('foreign_key_check') as unknown[]).length} violations.`,
      ''
    )
  }
  out.push(
    `Pages: ${pages} x ${pageSize} bytes, ${free} free. auto_vacuum: ${String(sqlite.pragma('auto_vacuum', { simple: true }))}.`,
    ''
  )
  let dbstat: { name: string; bytes: number }[] = []
  try {
    dbstat = sqlite
      .prepare('SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC')
      .all() as typeof dbstat
  } catch {
    out.push('(dbstat is not available in this SQLite build.)', '')
  }
  const kinds = new Map(
    (
      sqlite.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','index')").all() as {
        name: string
        type: string
      }[]
    ).map((r) => [r.name, r.type])
  )
  out.push('## Bytes per table and index', '', '| Name | Kind | Size | Rows |', '|---|---|---|---|')
  for (const row of dbstat.filter((r) => r.bytes > 8192)) {
    const kind = kinds.get(row.name) ?? 'other'
    const rows =
      kind === 'table'
        ? (sqlite.prepare(`SELECT COUNT(*) AS n FROM "${row.name}"`).get() as { n: number }).n
        : ''
    out.push(`| ${row.name} | ${kind} | ${mb(row.bytes)} | ${rows} |`)
  }
  out.push('', 'Tables under 8 KB are left out.', '')

  const ofp = sqlite
    .prepare(
      'SELECT COUNT(ofp_json) AS n, SUM(LENGTH(ofp_json)) AS bytes, MAX(LENGTH(ofp_json)) AS biggest FROM flight'
    )
    .get() as {
    n: number
    bytes: number | null
    biggest: number | null
  }
  out.push(
    `OFP JSON in \`flight.ofp_json\`: ${ofp.n} flights, ${mb(ofp.bytes ?? 0)} in total, the largest ${mb(ofp.biggest ?? 0)}.`,
    ''
  )
  const indexes = sqlite
    .prepare(
      "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name"
    )
    .all() as {
    name: string
    tbl_name: string
  }[]
  out.push('Indexes: ' + (indexes.map((i) => `${i.name} (${i.tbl_name})`).join(', ') || 'none') + '.', '')

  // Queries: the pages' own repo functions, timed.
  const flights = listFlights(db)
  const biggestFlight = (sqlite
    .prepare(
      'SELECT flight_id AS id, COUNT(*) AS n FROM track_point GROUP BY flight_id ORDER BY n DESC LIMIT 1'
    )
    .get() as { id: number; n: number } | undefined) ?? { id: flights[0]?.id ?? 0, n: 0 }
  const airportRows = sqlite
    .prepare('SELECT icao, COUNT(*) AS n FROM navdata_taxi_segment GROUP BY icao ORDER BY n DESC LIMIT 1')
    .get() as { icao: string; n: number } | undefined
  const bigAirport = airportRows?.icao ?? 'EGLL'

  const timings: { what: string; ms: number; note: string }[] = []
  const add = (what: string, t: { ms: number; result: unknown }, note: string): void =>
    void timings.push({ what, ms: t.ms, note })
  add(
    'Logbook list (listCompletedFlights)',
    time(() => listCompletedFlights(db)),
    `${flights.length} flights in total`
  )
  add(
    'All flights (listFlights, includes each OFP)',
    time(() => listFlights(db)),
    ''
  )
  add(
    'Logbook stats',
    time(() => getLogbookStats(db)),
    ''
  )
  add(
    'All landings',
    time(() => listAllLandings(db)),
    ''
  )
  add(
    `One flight's track (flight ${biggestFlight.id})`,
    time(() => listTrackPoints(db, biggestFlight.id)),
    `${biggestFlight.n} points, the largest`
  )
  add(
    'One flight (getFlight, with its OFP)',
    time(() => getFlight(db, biggestFlight.id)),
    ''
  )
  add(
    `Taxi network, ${bigAirport}`,
    time(() => listCachedTaxiSegments(db, bigAirport)),
    `${airportRows?.n ?? 0} segments, the largest cached`
  )
  add(
    `Runways, ${bigAirport}`,
    time(() => listCachedRunways(db, bigAirport)),
    ''
  )
  add(
    `SIDs, ${bigAirport}`,
    time(() => listCachedProcedures(db, bigAirport, 'sid', null)),
    ''
  )
  add(
    `Stands, ${bigAirport}`,
    time(() => listCachedStands(db, bigAirport)),
    ''
  )
  out.push(`## Query times (median of ${RUNS}, milliseconds)`, '', '| What | ms | Note |', '|---|---|---|')
  for (const t of timings) out.push(`| ${t.what} | ${t.ms.toFixed(2)} | ${t.note} |`)

  // Query plans for the filters the pages use: a SCAN reads the whole table.
  const plans: [string, string, unknown[]][] = [
    ['track_point by flight', 'SELECT * FROM track_point WHERE flight_id = ?', [biggestFlight.id]],
    ['navdata_taxi_segment by airport', 'SELECT * FROM navdata_taxi_segment WHERE icao = ?', [bigAirport]],
    ['navdata_stand by airport', 'SELECT * FROM navdata_stand WHERE icao = ?', [bigAirport]],
    ['navdata_runway by airport', 'SELECT * FROM navdata_runway WHERE icao = ?', [bigAirport]],
    [
      'navdata_procedure by airport and kind',
      "SELECT * FROM navdata_procedure WHERE icao = ? AND kind = 'sid'",
      [bigAirport]
    ],
    ['navdata_procedure_leg by procedure', 'SELECT * FROM navdata_procedure_leg WHERE procedure_id = ?', [1]],
    ['flights by status', "SELECT * FROM flight WHERE status = 'completed'", []],
    ['landings by flight', 'SELECT * FROM landing WHERE flight_id = ?', [biggestFlight.id]]
  ]
  out.push('', '## Query plans', '', '| Filter | Plan |', '|---|---|')
  for (const [what, sql, params] of plans) {
    try {
      const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]
      out.push(`| ${what} | ${plan.map((p) => p.detail).join('; ')} |`)
    } catch (error) {
      out.push(`| ${what} | (not run: ${String(error)}) |`)
    }
  }

  sqlite.close()
  const report = out.join('\n') + '\n'
  writeFileSync(join(outDir, 'report.md'), report)
  process.stdout.write(report)
}, 600_000)
