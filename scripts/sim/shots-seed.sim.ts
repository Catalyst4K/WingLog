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
  // Optional: the real navdata (runways, every SID, STAR and approach, stands and the taxi chart) for the flight's two airports from this
  // machine's own database, which the sim filled when those airports were flown. The scenario's own seed above holds only the few
  // procedures the recording used, so a screen that lists them looks nearly empty. Local only; nothing is written to the source database.
  const navdataSource = process.env.WINGLOG_SHOTS_TAXI_FROM
  if (navdataSource) {
    sqlite.prepare('ATTACH DATABASE ? AS source').run(navdataSource)
    for (const icao of ['WSSS', 'EGLL']) {
      const has = sqlite
        .prepare('SELECT COUNT(*) AS n FROM source.navdata_procedure WHERE icao = ?')
        .get(icao) as { n: number }
      // Replace the airport's seeded rows only when there is something real to replace them with.
      if (has.n === 0) continue
      const own = [icao]
      sqlite
        .prepare(
          'DELETE FROM navdata_procedure_leg WHERE procedure_id IN (SELECT id FROM navdata_procedure WHERE icao = ?)'
        )
        .run(...own)
      sqlite.prepare('DELETE FROM navdata_procedure WHERE icao = ?').run(...own)
      sqlite.prepare('DELETE FROM navdata_runway WHERE icao = ?').run(...own)
      sqlite
        .prepare('INSERT INTO navdata_procedure SELECT * FROM source.navdata_procedure WHERE icao = ?')
        .run(...own)
      sqlite
        .prepare(
          'INSERT INTO navdata_procedure_leg SELECT * FROM source.navdata_procedure_leg WHERE procedure_id IN (SELECT id FROM source.navdata_procedure WHERE icao = ?)'
        )
        .run(...own)
      sqlite
        .prepare('INSERT INTO navdata_runway SELECT * FROM source.navdata_runway WHERE icao = ?')
        .run(...own)
    }
    sqlite.exec(
      "INSERT INTO navdata_taxi_segment SELECT * FROM source.navdata_taxi_segment WHERE icao = 'WSSS'"
    )
    // Flight 236's own plan (EGLL to WSSS, the recorded flight), so the Dispatch page has figures to show.
    sqlite.exec(
      'UPDATE flight SET ofp_json = (SELECT ofp_json FROM source.flight WHERE id = 236) WHERE id = (SELECT MAX(id) FROM flight) AND EXISTS (SELECT 1 FROM source.flight WHERE id = 236 AND ofp_json IS NOT NULL)'
    )
    sqlite.exec('DETACH DATABASE source')
  }
  sqlite.close()
})
