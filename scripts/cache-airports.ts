/**
 * Caches taxi networks and stands for many airports in one sitting, for `npm run test:airports` (winglog-backend
 * docs/plans/robustness/scenario-testing.md Part 3). Needs MSFS running with an aircraft loaded, idle at any airport: the
 * facility requests are by airport code, so the airports needn't be near the aircraft.
 *
 * Which airports: every large airport in resources/airports.csv, every airport in this machine's logbook, and any codes given on
 * the command line. It writes to its own database, release/sim/airport-cache/winglog.db (gitignored: the networks are sim data), never
 * WingLog's, and skips airports already in it, so it can be stopped and run again.
 *
 * Usage: npm run cache:airports            (all of the above)
 *        npm run cache:airports -- EGLL KJFK
 *        WINGLOG_CACHE_LIMIT=40 npm run cache:airports   (stop after 40 new airports)
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { open, Protocol } from 'node-simconnect'
import { createDb } from '../src/main/db/client'
import { migrateDb } from '../src/main/db/migrate'
import {
  hasCachedTaxiNetwork,
  replaceAirportStands,
  replaceAirportTaxiSegments
} from '../src/main/db/navdata-repo'
import { fetchStands, fetchTaxiNetwork } from '../src/main/navdata/sim-facilities-fetch'
import Database from 'better-sqlite3'

/** Where the cache lives, relative to the project root. */
const CACHE_DIR = join('release', 'sim', 'airport-cache')
const CACHE_PATH = join(CACHE_DIR, 'winglog.db')
const LIMIT = Number(process.env.WINGLOG_CACHE_LIMIT ?? Infinity)

/** @returns The ICAO codes of resources/airports.csv's large airports. */
function largeAirports(): string[] {
  const lines = readFileSync(join('resources', 'airports.csv'), 'utf8').split(/\r?\n/)
  return lines.flatMap((line) => {
    const cells = line.split(',')
    return cells[4] === 'large_airport' && /^[A-Z0-9]{4}$/.test(cells[0]) ? [cells[0]] : []
  })
}

/** @returns Every airport in this machine's logbook, or none when there's no database. */
function logbookAirports(): string[] {
  const appData = process.env.APPDATA
  const path = appData ? join(appData, 'WingLog', 'winglog.db') : ''
  if (!path || !existsSync(path)) return []
  const sqlite = new Database(path, { readonly: true })
  try {
    const rows = sqlite
      .prepare('SELECT dep_icao AS dep, arr_icao AS arr FROM flight WHERE deleted_at IS NULL')
      .all() as { dep: string; arr: string }[]
    return rows.flatMap((r) => [r.dep, r.arr])
  } finally {
    sqlite.close()
  }
}

async function main(): Promise<void> {
  mkdirSync(CACHE_DIR, { recursive: true })
  const fresh = !existsSync(CACHE_PATH)
  if (fresh) migrateDb(CACHE_PATH, 'drizzle')
  const { db, sqlite } = createDb(CACHE_PATH)
  const asked = process.argv.slice(2).map((a) => a.toUpperCase())
  const all = [...new Set([...asked, ...logbookAirports(), ...largeAirports()])].filter((icao) =>
    /^[A-Z0-9]{4}$/.test(icao)
  )
  const todo = all.filter((icao) => !hasCachedTaxiNetwork(db, icao))
  console.log(
    `${all.length} airports wanted, ${all.length - todo.length} already cached, ${todo.length} to fetch.`
  )
  let { handle } = await open('WingLog airport cache', Protocol.SunRise)
  let done = 0
  try {
    for (const icao of todo) {
      if (done >= LIMIT) break
      const started = Date.now()
      // A refused request leaves that connection refusing the next, so each failure gets a fresh connection and one retry.
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const network = await fetchTaxiNetwork(handle, icao)
          const stands = await fetchStands(handle, icao)
          const now = new Date().toISOString()
          replaceAirportTaxiSegments(db, icao, network, now)
          replaceAirportStands(db, icao, stands, now)
          done++
          console.log(
            `${icao}: ${network.segments.length} segments, ${stands.length} stands (${Date.now() - started} ms) [${done}/${Math.min(todo.length, LIMIT)}]`
          )
          break
        } catch (error) {
          handle.close()
          handle = (await open('WingLog airport cache', Protocol.SunRise)).handle
          if (attempt === 2) {
            console.log(`${icao}: skipped (${error instanceof Error ? error.message : String(error)})`)
          }
        }
      }
    }
  } finally {
    handle.close()
    sqlite.close()
  }
  console.log(`Done: ${done} airports cached in ${CACHE_PATH}. Now: npm run test:airports`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
