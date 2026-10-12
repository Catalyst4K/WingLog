/**
 * Live check of the AIRAC refresh (winglog-backend docs/plans/robustness/performance-and-storage.md,
 * Answers 2): copies this machine's WingLog database, picks an airport whose cached data predates the
 * current cycle, uses it through the real SimFacilitiesProvider and waits for the background refresh to
 * re-fetch it from the running sim. Needs MSFS running with an aircraft loaded. It never touches
 * WingLog's own database: the copy lives in release/sim/airac-check/ (gitignored).
 *
 * Usage: npm run spike:airac [-- ICAO]
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { airacCycleStart, predatesCurrentCycle } from '../src/shared/airac'
import { createDb } from '../src/main/db/client'
import { listCachedProcedures, listCachedRunways, navdataFetchTimes } from '../src/main/db/navdata-repo'
import { navdataRunway } from '../src/main/db/schema'
import { SimFacilitiesProvider } from '../src/main/navdata/sim-facilities-provider'

const DIR = join('release', 'sim', 'airac-check')
const WAIT_MS = 90_000

async function main(): Promise<void> {
  const appData = process.env.APPDATA
  const source = appData ? join(appData, 'WingLog', 'winglog.db') : ''
  if (!source || !existsSync(source)) throw new Error('No WingLog database in %APPDATA%\\WingLog')
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(DIR, { recursive: true })
  const copy = join(DIR, 'winglog.db')
  for (const suffix of ['', '-wal', '-shm'])
    if (existsSync(source + suffix)) copyFileSync(source + suffix, copy + suffix)
  const { db, sqlite } = createDb(copy)

  const now = new Date()
  const asked = process.argv[2]?.toUpperCase()
  const candidates = db
    .selectDistinct({ icao: navdataRunway.icao })
    .from(navdataRunway)
    .all()
    .map((r) => r.icao)
    .filter((icao) => {
      const at = navdataFetchTimes(db, icao).airport
      return at !== null && predatesCurrentCycle(at, now)
    })
  const icao = asked ?? candidates[0]
  if (!icao) throw new Error('Every cached airport is already in the current cycle: nothing stale to refresh')

  const before = navdataFetchTimes(db, icao)
  const runwaysBefore = listCachedRunways(db, icao)
  const proceduresBefore = listCachedProcedures(db, icao, 'star', null).length
  console.log(
    `Cycle in force since ${airacCycleStart(now).toISOString()}; ${candidates.length} airports stale.`
  )
  console.log(
    `${icao}: fetched ${before.airport}, ${runwaysBefore.length} runway ends, ${proceduresBefore} STARs.`
  )

  const provider = new SimFacilitiesProvider(db)
  provider.listRunways(icao)
  const started = Date.now()
  while (Date.now() - started < WAIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const at = navdataFetchTimes(db, icao).airport
    if (at !== before.airport) break
  }
  const after = navdataFetchTimes(db, icao)
  const runwaysAfter = listCachedRunways(db, icao)
  const proceduresAfter = listCachedProcedures(db, icao, 'star', null).length
  const refreshed = after.airport !== before.airport
  console.log(
    refreshed
      ? `${icao}: refreshed ${after.airport} after ${((Date.now() - started) / 1000).toFixed(1)} s; ${runwaysAfter.length} runway ends, ${proceduresAfter} STARs.`
      : `${icao}: NOT refreshed within ${WAIT_MS / 1000} s.`
  )
  if (refreshed) {
    const moved = runwaysAfter.filter((r) => {
      const old = runwaysBefore.find((o) => o.ident === r.ident)
      return !old || old.thresholdLat !== r.thresholdLat || old.thresholdLon !== r.thresholdLon
    })
    console.log(`Runway ends that differ from the cache: ${moved.length}`)
  }
  sqlite.close()
  process.exit(refreshed ? 0 : 1)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
