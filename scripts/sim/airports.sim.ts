/**
 * `npm run test:airports`: the taxi route rules (airport-rules.ts) over every airport whose taxi network is cached on this machine.
 * Reads WingLog's database read-only and writes release/sim/airports/index.html (gitignored: the networks are sim data). Not part of
 * `npm test`: it needs the local cache, which grows as airports are flown from or cached by scripts/cache-airports.ts
 * (winglog-backend docs/plans/robustness/scenario-testing.md Part 3).
 *
 * WINGLOG_AIRPORTS_COUNT sets the clearances per airport (default 60); WINGLOG_AIRPORTS_SEED the seed (default 1).
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { NavdataStand, NavdataTaxiSegment } from '../../src/shared/ipc'
import { listCachedStands, listCachedTaxiSegments } from '../../src/main/db/navdata-repo'
import { navdataTaxiSegment } from '../../src/main/db/schema'
import { seeded } from '../phase-rules'
import { buildNetwork, checkClearance, generateClearances } from './airport-rules'
import { airportsReport, type AirportOutcome } from './airports-report'
import { openUserDb, userDataDir } from './local-data'
import { writeReport } from './report'

const COUNT = Number(process.env.WINGLOG_AIRPORTS_COUNT ?? 60)
const SEED = Number(process.env.WINGLOG_AIRPORTS_SEED ?? 1)

/** A stable number from an airport code, so each airport gets its own repeatable clearances. */
const hash = (icao: string): number => [...icao].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)

/** Where scripts/cache-airports.ts puts the airports it fetched. */
const CACHE_DIR = join(process.cwd(), 'release', 'sim', 'airport-cache')

/** One airport's network and stands, from whichever database has it. */
interface Source {
  icao: string
  segments: NavdataTaxiSegment[]
  stands: NavdataStand[]
}

/**
 * @returns Every airport cached in WingLog's own database or in the airport cache, the cache's copy where both have it.
 */
function cachedAirports(): Source[] {
  const bySource = new Map<string, Source>()
  for (const dir of [userDataDir(), CACHE_DIR]) {
    if (!existsSync(join(dir, 'winglog.db'))) continue
    const { db, close } = openUserDb(dir)
    try {
      const icaos = db.selectDistinct({ icao: navdataTaxiSegment.icao }).from(navdataTaxiSegment).all()
      for (const { icao } of icaos) {
        bySource.set(icao, {
          icao,
          segments: listCachedTaxiSegments(db, icao),
          stands: listCachedStands(db, icao)
        })
      }
    } finally {
      close()
    }
  }
  return [...bySource.values()].sort((a, b) => a.icao.localeCompare(b.icao))
}

it('traces every generated clearance correctly at every cached airport', () => {
  const airports: AirportOutcome[] = cachedAirports().map(({ icao, segments, stands }) => {
    const network = buildNetwork(segments)
    const outcomes = generateClearances(network, stands, seeded(SEED + hash(icao)), COUNT).map(
      (generated) => ({
        generated,
        ...checkClearance(network, segments, generated)
      })
    )
    return { icao, segments, standCount: stands.length, outcomes }
  })
  const failedIn = (a: AirportOutcome): number => a.outcomes.filter((o) => o.failures.length > 0).length
  const page = writeReport('airports', airportsReport(airports, SEED), {
    seed: SEED,
    airports: airports.map((a) => ({
      icao: a.icao,
      clearances: a.outcomes.length,
      failed: failedIn(a),
      failures: a.outcomes.flatMap((o) => o.failures.map((f) => f.rule))
    }))
  })
  const total = airports.reduce((sum, a) => sum + a.outcomes.length, 0)
  const failed = airports.reduce((sum, a) => sum + failedIn(a), 0)
  console.log(`${airports.length} airports, ${total} clearances, ${failed} failed a rule. Report: ${page}`)
  expect(airports.length).toBeGreaterThan(0)
})
