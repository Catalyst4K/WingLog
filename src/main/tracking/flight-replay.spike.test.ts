/**
 * Phase 1 spike (flightdeck-backend/docs/plans/flight-replay-harness.md): replays a
 * captured flight fixture through the real TrackingController/FlightRecorder against a
 * scratch DB and prints what got recorded — the correctness check on
 * ReplaySimConnectService itself Phase 1 asks for.
 *
 * Written as a vitest test rather than a plain scripts/*.ts spike (like
 * scripts/spike-capture-flight.ts) because TrackingController's landing-capture path pulls
 * in airport-search.ts/runway-lookup.ts, both of which use Vite's `?raw` CSV import — real
 * under vitest (same Vite module graph as production and TrackingController.test.ts) but
 * unresolvable under a bare tsx/node runtime (confirmed: a plain-tsx version of this script
 * threw `SyntaxError: Unexpected identifier 'RF'` trying to parse resources/airports.csv as
 * JS — tsx has no `?raw` loader, Vite does).
 *
 * Skipped by default — real captured flight data stays local (CLAUDE.md's Security
 * section), so there's no fixture to point at on another machine or in CI. Run locally with:
 *   WINGLOG_REPLAY_FIXTURE=flight-captures/<file>.ndjson npm test -- flight-replay.spike
 *
 * Not a permanent regression test: the fixture isn't scrubbed/anonymized yet (Design §4 of
 * the plan doc), so it can't be committed and run everywhere. That's Phase 3's job, once a
 * trimmed fixture exists.
 */
import { describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { FlightPhase } from '@shared/ipc'
import { createAircraft } from '../db/aircraft-repo'
import { createDb } from '../db/client'
import { createFlight, getFlight } from '../db/flight-repo'
import { getLandingByFlight } from '../db/landing-repo'
import { listTrackPoints } from '../db/track-point-repo'
import type { SimConnectService } from '../sim/SimConnectService'
import { ReplaySimConnectService, type ReplayMode } from '../sim/ReplaySimConnectService'
import { TrackingController } from './TrackingController'

const fixturePath = process.env['WINGLOG_REPLAY_FIXTURE']
const depIcao = (process.env['WINGLOG_REPLAY_DEP_ICAO'] ?? 'EGLL').toUpperCase()
const arrIcao = (process.env['WINGLOG_REPLAY_ARR_ICAO'] ?? 'EGCC').toUpperCase()
const mode: ReplayMode = process.env['WINGLOG_REPLAY_MODE'] === 'paced' ? 'paced' : 'instant'
const speedMultiplier = Number(process.env['WINGLOG_REPLAY_SPEED'] ?? 1)

describe.skipIf(!fixturePath)('flight replay harness Phase 1 spike', () => {
  it(
    'replays a real captured flight through TrackingController end to end',
    async () => {
      const { db } = createDb(':memory:')
      migrate(db, { migrationsFolder: 'drizzle' })

      const replay = new ReplaySimConnectService(fixturePath as string, { mode, speedMultiplier })
      console.log(`Fixture header: ${JSON.stringify(replay.header)}`)

      const aircraft = createAircraft(db, { registration: 'REPLAY', icaoType: replay.header.aircraftType })
      const flight = createFlight(db, { aircraftId: aircraft.id, depIcao, arrIcao })
      console.log(`Flight ${flight.id}: ${depIcao} -> ${arrIcao}, aircraft "${replay.header.aircraftType}"`)

      const controller = new TrackingController(db, replay as unknown as SimConnectService)
      const phaseLog: { phase: FlightPhase; atMs: number }[] = []
      let lastPhase: FlightPhase | undefined
      const startedAt = Date.now()
      controller.on('point', (point) => {
        if (point.phase !== lastPhase) {
          lastPhase = point.phase
          phaseLog.push({ phase: point.phase, atMs: Date.now() - startedAt })
        }
      })

      const completedFlightId = await new Promise<number>((resolve, reject) => {
        controller.on('completed', resolve)
        replay.on('replayComplete', () => {
          reject(
            new Error(
              `Fixture ended without TrackingController ever completing the flight — last phase seen: ${lastPhase ?? '(none)'}`
            )
          )
        })
        controller.start(flight.id)
        replay.start()
      })

      const finalFlight = getFlight(db, completedFlightId)
      const points = listTrackPoints(db, completedFlightId)
      const landing = getLandingByFlight(db, completedFlightId)
      const pointsByPhase = new Map<FlightPhase, number>()
      for (const p of points) pointsByPhase.set(p.phase, (pointsByPhase.get(p.phase) ?? 0) + 1)

      console.log('\n=== Replay summary ===')
      console.log('Phase sequence (first point of each phase, ms since replay start):')
      for (const entry of phaseLog) console.log(`  ${entry.phase.padEnd(10)} ${entry.atMs}ms`)
      console.log(`\nTrack points recorded: ${points.length} (of ${replay.telemetryTickCount} fixture telemetry ticks)`)
      for (const [phase, count] of pointsByPhase) console.log(`  ${phase.padEnd(10)} ${count}`)
      console.log(`\nFlight row: status=${finalFlight?.status} fuelOutKg=${finalFlight?.fuelOutKg} fuelInKg=${finalFlight?.fuelInKg}`)
      console.log(`  actualOutUtc=${finalFlight?.actualOutUtc}`)
      console.log(`  actualOffUtc=${finalFlight?.actualOffUtc}`)
      console.log(`  actualOnUtc=${finalFlight?.actualOnUtc}`)
      console.log(`  actualInUtc=${finalFlight?.actualInUtc}`)
      if (landing) {
        const vsFpm = Math.round(landing.verticalSpeedMs * 196.85)
        console.log(`\nLanding: vs=${vsFpm}fpm runway=${landing.runwayIdent ?? '(none matched)'}`)
      } else {
        console.log('\nNo landing record created.')
      }
      console.log(
        '\nFinding (confirmed here, not hypothetical): under instant mode the whole fixture replays in well ' +
          'under a second of real wall time, so FlightRecorder.shouldRecord (keyed off real elapsed seconds, ' +
          'not the fixture\'s own tOffsetMs) almost never crosses its per-phase interval — only the mandatory ' +
          "first tick gets persisted as a track_point; every later tick still advances the phase machine and " +
          'drives OFF/ON/landing/completion correctly (those check result.phase, not result.point), but the ' +
          'map/track itself would render as a single dot. Anything that needs real point density (a visual ' +
          "track, resume-cleanup's jump detection, which needs a previous/current pair to compare) needs " +
          "paced mode at speedMultiplier 1 (real time), not instant — see this file's own doc comment."
      )

      replay.stop()

      // Assertions deliberately don't depend on phaseLog/point density — the finding above
      // is that those are near-empty at instant speed by design, not a bug. What IS
      // speed-independent (tick-count-driven, not wall-clock-driven): phase completion,
      // OFF/ON detection, and the landing capture itself.
      expect(finalFlight?.status).toBe('completed')
      expect(finalFlight?.actualOutUtc).toBeTruthy()
      expect(finalFlight?.actualOffUtc).toBeTruthy()
      expect(finalFlight?.actualOnUtc).toBeTruthy()
      expect(finalFlight?.actualInUtc).toBeTruthy()
      const times = [finalFlight?.actualOutUtc, finalFlight?.actualOffUtc, finalFlight?.actualOnUtc, finalFlight?.actualInUtc].map(
        (t) => new Date(t as string).getTime()
      )
      expect(times, 'OUT/OFF/ON/IN should be non-decreasing').toEqual([...times].sort((a, b) => a - b))
      expect(points.length).toBeGreaterThan(0)
      expect(landing).toBeDefined()
      expect(landing?.runwayIdent).toBeTruthy()
    },
    60_000
  )
})
