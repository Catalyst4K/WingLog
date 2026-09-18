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
import { nearestAirport } from '../airports/airport-search'
import { createAircraft } from '../db/aircraft-repo'
import { createDb } from '../db/client'
import { createFlight, getFlight } from '../db/flight-repo'
import { getLandingByFlight, listLandingsByFlight } from '../db/landing-repo'
import { listTrackPoints } from '../db/track-point-repo'
import { ReplaySimConnectService } from '../sim/ReplaySimConnectService'
import { TrackingController } from './TrackingController'

function fixturePath(name: string): string {
  return new URL(`./__fixtures__/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
}

const FIXTURE_PATH = fixturePath('short-hop-egll-egcc.ndjson')

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

describe('flight replay harness (real fixture) — multiple landings', () => {
  it(
    'captures every real touchdown of a circuits flight, including the firm landing that ' +
      'the old one-per-flight capture used to lose (flightdeck-backend docs/plans/multiple-landings.md)',
    async () => {
      const { db } = createDb(':memory:')
      migrate(db, { migrationsFolder: 'drizzle' })

      const replay = new ReplaySimConnectService(fixturePath('tier2-circuits-firm-landing-goaround-crash.ndjson'), {
        mode: 'instant'
      })
      const aircraft = createAircraft(db, { registration: 'REPLAY', icaoType: replay.header.aircraftType })
      const flight = createFlight(db, { aircraftId: aircraft.id, depIcao: 'VHHH', arrIcao: 'VHHH' })

      const controller = new TrackingController(db, replay)

      // This fixture ends with a real crash, not a normal shutdown (parking brake never
      // sets, engines never stop) — 'completed' never fires, only replayComplete. That
      // itself is worth asserting: a flight this plan's own real motivating case produces
      // must not silently pretend to complete normally.
      await new Promise<void>((resolve) => {
        replay.on('replayComplete', resolve)
        controller.start(flight.id)
        replay.start()
      })

      const landings = listLandingsByFlight(db, flight.id)

      // Independently re-derived from the raw fixture's own onGround transitions with the
      // same hysteresis TrackingController.detectTouchdown applies (>=3 consecutive
      // airborne samples) — not asserting an arbitrary number.
      expect(landings.map((l) => l.seq)).toEqual([1, 2, 3, 4])

      // The real finding this plan exists to fix: flight 198's deliberately firm landing
      // (g-force 1.68, flight-replay-harness.md's 2026-09-14 entry) used to be overwritten
      // by an earlier accidental soft touchdown under the old one-row-per-flight capture.
      // It must now survive as its own row rather than being lost.
      const firmLanding = landings.find((l) => l.gForce > 1.5)
      expect(firmLanding).toBeDefined()
      expect(firmLanding?.gForce).toBeCloseTo(1.68, 1)

      // Every captured landing is a real, distinct touchdown — none accidentally collapsed
      // onto another's row.
      const ids = new Set(landings.map((l) => l.id))
      expect(ids.size).toBe(landings.length)

      expect(getFlight(db, flight.id)?.status).toBe('active') // never reached shutdown
      replay.stop()
    },
    60_000
  )
})

describe('flight replay harness (real fixture) — free flight tracking', () => {
  it(
    'replays a real VHHH VFR hop with no OFP through TrackingController.startFree, producing a complete ' +
      'logbook entry — the exact scenario 2026-09-14 flight 5 confirmed could not be tracked at all before ' +
      'free-flight-tracking.md',
    async () => {
      const { db } = createDb(':memory:')
      migrate(db, { migrationsFolder: 'drizzle' })

      const replay = new ReplaySimConnectService(fixturePath('tier2-vfr-no-ofp-short-hop.ndjson'), {
        mode: 'instant'
      })
      const firstTelemetry = replay.getLastTelemetry()
      if (!firstTelemetry) throw new Error('fixture has no telemetry')
      const aircraft = createAircraft(db, { registration: 'G-TEST', icaoType: 'C172' })

      const controller = new TrackingController(db, replay)

      // Resolved from position, the same way the real "Start a free flight" dialog's
      // Departure field would — nothing was ever filed for this flight, the whole point of
      // the scenario (free-flight-tracking.md's aircraft-identity table, VHHH is real
      // vendored data at this exact position, not assumed).
      const depIcao = nearestAirport(firstTelemetry.latitude, firstTelemetry.longitude, 15) ?? 'ZZZZ'
      expect(depIcao).toBe('VHHH')

      const flightId = controller.startFree({ aircraftId: aircraft.id, depIcao, arrIcao: 'ZZZZ', flightNumber: null })

      await new Promise<void>((resolve) => {
        replay.on('replayComplete', resolve)
        replay.start()
      })

      // Same real-data quirk this plan's own circuits fixture hit (see the describe block
      // above): the capture ends parked but with the engine still running and the parking
      // brake never set, so shutdown detection never fires on its own — a pilot would press
      // "Finish & save" here, which is exactly what this does.
      controller.finish()

      const finalFlight = getFlight(db, flightId)
      const points = listTrackPoints(db, flightId)
      const landing = getLandingByFlight(db, flightId)

      expect(finalFlight?.status).toBe('completed')
      // Genuinely no plan filed — the whole reason this flight needed free-flight-tracking.md
      // at all, not just a completion-time coincidence.
      expect(finalFlight?.ofpJson).toBeNull()
      expect(finalFlight?.depIcao).toBe('VHHH')
      // Arrival resolved from the real touchdown position (free-flight-tracking.md's
      // "Arrival is resolved, not filed"), not left as the ZZZZ placeholder this flight
      // started with.
      expect(finalFlight?.arrIcao).not.toBe('ZZZZ')
      expect(finalFlight?.arrIcao).toMatch(/^[A-Z0-9]{4}$/)
      expect(finalFlight?.actualOffUtc).toBeTruthy()
      expect(finalFlight?.actualOnUtc).toBeTruthy()
      expect(points.length).toBeGreaterThan(0)
      expect(landing).toBeDefined()
      expect(landing?.icao).toBe(finalFlight?.arrIcao)

      replay.stop()
    },
    60_000
  )
})
