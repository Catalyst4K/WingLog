/**
 * Replays a real captured flight fixture (scrubbed per CLAUDE.md's Security section — see
 * __fixtures__/short-hop-egll-egcc.ndjson's own header) through the real
 * TrackingController/FlightRecorder against a scratch DB. Closes flightdeck-backend's
 * docs/plans/flight-replay-harness.md Phase 3: the permanent regression test a committed
 * fixture makes possible, following on from Phase 1's one-off spike cross-check against the
 * same underlying flight (EGLL -> EGCC, Fenix A320, pushback to shutdown).
 *
 * Written as a vitest test rather than a plain scripts/*.ts spike because
 * TrackingController's landing-capture path pulls in airport-search.ts/runway-lookup.ts,
 * both of which use Vite's `?raw` CSV import — real under vitest (same Vite module graph as
 * production and TrackingController.test.ts) but unresolvable under a bare tsx/node runtime.
 */
import { describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createAircraft } from '../db/aircraft-repo'
import { createDb } from '../db/client'
import { createFlight, getFlight } from '../db/flight-repo'
import { getLandingByFlight } from '../db/landing-repo'
import { listTrackPoints } from '../db/track-point-repo'
import { ReplaySimConnectService } from '../sim/ReplaySimConnectService'
import { TrackingController } from './TrackingController'

const FIXTURE_PATH = new URL('./__fixtures__/short-hop-egll-egcc.ndjson', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1'
)

describe('flight replay harness (real fixture)', () => {
  it(
    'replays a real captured EGLL -> EGCC flight through TrackingController end to end',
    async () => {
      const { db } = createDb(':memory:')
      migrate(db, { migrationsFolder: 'drizzle' })

      const replay = new ReplaySimConnectService(FIXTURE_PATH, { mode: 'instant' })
      const aircraft = createAircraft(db, { registration: 'REPLAY', icaoType: replay.header.aircraftType })
      const flight = createFlight(db, { aircraftId: aircraft.id, depIcao: 'EGLL', arrIcao: 'EGCC' })

      const controller = new TrackingController(db, replay)

      const completedFlightId = await new Promise<number>((resolve, reject) => {
        controller.on('completed', resolve)
        replay.on('replayComplete', () =>
          reject(new Error('Fixture ended without TrackingController ever completing the flight'))
        )
        controller.start(flight.id)
        replay.start()
      })

      const finalFlight = getFlight(db, completedFlightId)
      const points = listTrackPoints(db, completedFlightId)
      const landing = getLandingByFlight(db, completedFlightId)

      // Assertions deliberately don't depend on point density — under instant mode
      // FlightRecorder.shouldRecord's wall-clock-based downsampling persists only the
      // mandatory first track_point (Phase 1 finding, flight-replay-harness.md). What IS
      // speed-independent (tick-count-driven, not wall-clock-driven): phase completion,
      // OFF/ON detection, and the landing capture itself.
      expect(finalFlight?.status).toBe('completed')
      expect(finalFlight?.actualOutUtc).toBeTruthy()
      expect(finalFlight?.actualOffUtc).toBeTruthy()
      expect(finalFlight?.actualOnUtc).toBeTruthy()
      expect(finalFlight?.actualInUtc).toBeTruthy()
      const times = [
        finalFlight?.actualOutUtc,
        finalFlight?.actualOffUtc,
        finalFlight?.actualOnUtc,
        finalFlight?.actualInUtc
      ].map((t) => new Date(t as string).getTime())
      expect(times, 'OUT/OFF/ON/IN should be non-decreasing').toEqual([...times].sort((a, b) => a - b))
      expect(points.length).toBeGreaterThan(0)
      expect(landing).toBeDefined()
      expect(landing?.runwayIdent).toBe('23R')

      replay.stop()
    },
    60_000
  )
})
