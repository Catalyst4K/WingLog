/**
 * Not a real test — e2e test setup, piggybacking on vitest because TrackingController's
 * landing-capture path pulls in airport-search.ts/runway-lookup.ts, both of which use
 * Vite's `?raw` CSV import (real under vitest's Vite module graph, unresolvable under a
 * bare tsx/node runtime — same reason flight-replay.test.ts lives here rather than as a
 * plain scripts/*.ts spike, see its own doc comment). Produces a real `winglog.db`
 * containing two fully completed flights by running committed replay fixtures through the
 * actual production TrackingController/FlightRecorder/landing-capture pipeline — exactly
 * what flight-replay.test.ts already proves works, just written to a real file instead of
 * `:memory:` so e2e/logbook.spec.ts has something real to browse: a single-landing short
 * hop (EGLL -> EGCC), and the VHHH circuits flight with several real touchdowns
 * (flightdeck-backend's docs/plans/multiple-landings.md).
 *
 * A no-op under a normal `npm test`/`npm run test:coverage` run (WINGLOG_E2E_SEED_DB_PATH
 * unset) — only does anything when e2e/logbook.spec.ts's beforeAll invokes vitest directly
 * against this one file with that env var set.
 */
import { describe, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createAircraft } from '../db/aircraft-repo'
import { createDb } from '../db/client'
import { createFlight } from '../db/flight-repo'
import { ReplaySimConnectService } from '../sim/ReplaySimConnectService'
import { TrackingController } from './TrackingController'

function fixturePath(name: string): string {
  return new URL(`./__fixtures__/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
}

const SHORT_HOP_FIXTURE_PATH = fixturePath('short-hop-egll-egcc.ndjson')
const CIRCUITS_FIXTURE_PATH = fixturePath('tier2-circuits-firm-landing-goaround-crash.ndjson')

describe('e2e setup: seed completed flights (not a real test)', () => {
  const outputPath = process.env.WINGLOG_E2E_SEED_DB_PATH

  it.skipIf(!outputPath)('replays the fixtures into a real db file for Logbook e2e coverage', async () => {
    const { db, sqlite } = createDb(outputPath as string)
    migrate(db, { migrationsFolder: 'drizzle' })

    const shortHop = new ReplaySimConnectService(SHORT_HOP_FIXTURE_PATH, { mode: 'instant' })
    const shortHopAircraft = createAircraft(db, { registration: 'G-TEST', icaoType: shortHop.header.aircraftType })
    const shortHopFlight = createFlight(db, { aircraftId: shortHopAircraft.id, depIcao: 'EGLL', arrIcao: 'EGCC' })
    const shortHopController = new TrackingController(db, shortHop)
    await new Promise<number>((resolve, reject) => {
      shortHopController.on('completed', resolve)
      shortHop.on('replayComplete', () =>
        reject(new Error('short-hop fixture ended without TrackingController ever completing the flight'))
      )
      shortHopController.start(shortHopFlight.id)
      shortHop.start()
    })
    shortHop.stop()

    // The circuits fixture ends in a real crash — parking brake never sets, engines never
    // stop, so the phase machine's own shutdown detection never fires (confirmed against
    // the real fixture: flight-replay.test.ts's own "multiple landings" describe block
    // asserts on exactly this). Finished manually afterwards, the same as a real pilot
    // hitting "Finish & save" after one, rather than waiting for a shutdown that never
    // comes.
    const circuits = new ReplaySimConnectService(CIRCUITS_FIXTURE_PATH, { mode: 'instant' })
    const circuitsAircraft = createAircraft(db, { registration: 'G-CIRC', icaoType: circuits.header.aircraftType })
    const circuitsFlight = createFlight(db, { aircraftId: circuitsAircraft.id, depIcao: 'VHHH', arrIcao: 'VHHH' })
    const circuitsController = new TrackingController(db, circuits)
    await new Promise<void>((resolve) => {
      circuits.on('replayComplete', resolve)
      circuitsController.start(circuitsFlight.id)
      circuits.start()
    })
    circuitsController.finish()
    circuits.stop()

    sqlite.close()
  }, 60_000)
})
