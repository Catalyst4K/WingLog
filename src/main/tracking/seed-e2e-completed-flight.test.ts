/**
 * Not a real test — e2e test setup, piggybacking on vitest because TrackingController's
 * landing-capture path pulls in airport-search.ts/runway-lookup.ts, both of which use
 * Vite's `?raw` CSV import (real under vitest's Vite module graph, unresolvable under a
 * bare tsx/node runtime — same reason flight-replay.test.ts lives here rather than as a
 * plain scripts/*.ts spike, see its own doc comment). Produces a real `winglog.db`
 * containing one fully completed flight (OUT/OFF/ON/IN, real track points, a real landing
 * row) by running the committed replay fixture through the actual production
 * TrackingController/FlightRecorder/landing-capture pipeline — exactly what
 * flight-replay.test.ts already proves works, just written to a real file instead of
 * `:memory:` so e2e/logbook.spec.ts has something real to browse.
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

const FIXTURE_PATH = new URL('./__fixtures__/short-hop-egll-egcc.ndjson', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1'
)

describe('e2e setup: seed a completed flight (not a real test)', () => {
  const outputPath = process.env.WINGLOG_E2E_SEED_DB_PATH

  it.skipIf(!outputPath)('replays the fixture into a real db file for Logbook e2e coverage', async () => {
    const { db, sqlite } = createDb(outputPath as string)
    migrate(db, { migrationsFolder: 'drizzle' })

    const replay = new ReplaySimConnectService(FIXTURE_PATH, { mode: 'instant' })
    const aircraft = createAircraft(db, { registration: 'G-TEST', icaoType: replay.header.aircraftType })
    const flight = createFlight(db, { aircraftId: aircraft.id, depIcao: 'EGLL', arrIcao: 'EGCC' })

    const controller = new TrackingController(db, replay)

    await new Promise<number>((resolve, reject) => {
      controller.on('completed', resolve)
      replay.on('replayComplete', () =>
        reject(new Error('Fixture ended without TrackingController ever completing the flight'))
      )
      controller.start(flight.id)
      replay.start()
    })

    replay.stop()
    sqlite.close()
  }, 60_000)
})
