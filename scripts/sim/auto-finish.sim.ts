/**
 * `npm run sim -- auto-finish`: every dev-build capture with a landing replayed through the real app, and when each flight now
 * finishes by itself compared with what happened live (winglog-backend docs/decisions.md 2026-11-02). Reads WingLog's captures and
 * database read-only; writes release/sim/auto-finish/index.html (gitignored: it shows real flights). Not part of `npm test`: it
 * needs captures.
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { it, vi } from 'vitest'
import { getFlight } from '../../src/main/db/flight-repo'
import { listTrackPoints } from '../../src/main/db/track-point-repo'
import { parseFlightFixture } from '../../src/main/sim/flight-fixture'
import { touchdownOffsetMs } from '../scenarios/bases'
import { runScenario, trackingEndedAtMs } from '../scenarios/harness'
import { arrivalTicks, liveFinish, listCaptures, type ArrivalFindings } from './auto-finish'
import { autoFinishReport } from './auto-finish-report'
import { openUserDb, userDataDir } from './local-data'
import { writeReport } from './report'

it('simulates auto-finish on every recorded arrival', async () => {
  const findings: ArrivalFindings[] = []
  const skipped: string[] = []
  const { db: userDb, close } = openUserDb()
  try {
    for (const path of listCaptures(userDataDir())) {
      const capture = parseFlightFixture(readFileSync(path, 'utf8'))
      const flightId = (capture.header as { flightId?: number }).flightId
      const live = flightId === undefined ? undefined : getFlight(userDb, flightId)
      if (flightId === undefined || !live) {
        skipped.push(`${basename(path)} (no flight in the logbook)`)
        continue
      }
      let touchdownMs: number
      try {
        touchdownMs = touchdownOffsetMs(capture)
      } catch {
        skipped.push(
          `flight ${flightId}'s capture of ${capture.header.capturedAt.slice(0, 10)} (no landing in it)`
        )
        continue
      }
      vi.useFakeTimers({ toFake: ['Date'] })
      const result = await runScenario(capture, {
        depIcao: live.depIcao,
        arrIcao: live.arrIcao,
        setClock: (ms) => vi.setSystemTime(ms)
      })
      vi.useRealTimers()
      const capturedAtMs = Date.parse(capture.header.capturedAt)
      const ticks = arrivalTicks(capture, touchdownMs)
      findings.push({
        flightId,
        route: `${live.depIcao} to ${live.arrIcao}`,
        aircraft: capture.header.aircraftType,
        capturedAtMs,
        touchdownMs,
        endMs: ticks.at(-1)?.tOffsetMs ?? touchdownMs,
        ticks,
        live: liveFinish(listTrackPoints(userDb, flightId), live, capturedAtMs),
        replayFinishMs: trackingEndedAtMs(result.samples)
      })
    }
  } finally {
    close()
  }
  const results = findings.map(({ ticks, ...rest }) => ({ ...rest, ticks: ticks.length }))
  const page = writeReport('auto-finish', autoFinishReport(findings, skipped), { results, skipped })
  process.stdout.write(`auto-finish report: ${page}\n`)
})
