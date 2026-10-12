/**
 * `npm run sim -- shots-seed`: not a simulation, set-up for e2e/flight-sim.shots.ts. Writes a fresh `winglog.db` at
 * WINGLOG_SHOTS_DB_PATH with an aircraft, a planned EGLL to WSSS flight, and WSSS's runways and approaches cached, so the real
 * built app can replay flight 236's descent and show its arrival card (winglog-backend
 * docs/plans/robustness/scenario-testing.md Part 6, "Real-app screenshots"). A no-op without that variable.
 */
import { it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createAircraft } from '../../src/main/db/aircraft-repo'
import { createDb } from '../../src/main/db/client'
import { createFlight } from '../../src/main/db/flight-repo'
import { WSSS_ARRIVAL, WSSS_RUNWAYS, seedApproaches, seedRunways } from '../scenarios/bases'

const outputPath = process.env.WINGLOG_SHOTS_DB_PATH

it.skipIf(!outputPath)('writes the screenshots database', () => {
  const { db, sqlite } = createDb(outputPath as string)
  migrate(db, { migrationsFolder: 'drizzle' })
  const aircraft = createAircraft(db, { registration: 'G-TEST', icaoType: 'A388' })
  createFlight(db, { aircraftId: aircraft.id, depIcao: 'EGLL', arrIcao: 'WSSS' })
  seedRunways(db, 'WSSS', WSSS_RUNWAYS)
  seedApproaches(db, WSSS_ARRIVAL)
  sqlite.close()
})
