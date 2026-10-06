/**
 * `npm run sim -- taxi`: the taxi line simulation on this machine's real taxis. Reads WingLog's
 * database and logs read-only and writes release/sim/taxi/index.html (gitignored). Not part of
 * `npm test`: it needs local data (flightdeck-backend docs/plans/robustness/scenario-testing.md
 * Part 6).
 *
 * Taxis from before the InfoBoxes were logged (2026-10-05) can be added by hand in
 * release/sim/taxi/hand-scenarios.json, a list of HandScenario (taxi.ts).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'vitest'
import { getFlight, listFlights } from '../../src/main/db/flight-repo'
import { listCachedStands, listCachedTaxiSegments } from '../../src/main/db/navdata-repo'
import { listTrackPoints } from '../../src/main/db/track-point-repo'
import { openUserDb, readInfoBoxesLogs } from './local-data'
import { simOutputDir, writeReport } from './report'
import { runTaxi, scenarioFromHand, scenariosFromLog, type HandScenario, type TaxiScenario } from './taxi'
import { taxiReport, type TaxiOutcome } from './taxi-report'

function handScenarios(): HandScenario[] {
  const path = join(simOutputDir('taxi'), 'hand-scenarios.json')
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as HandScenario[]) : []
}

it('simulates the taxi line on real taxis', () => {
  const { db, close } = openUserDb()
  try {
    const pointsFor = (flightId: number) => listTrackPoints(db, flightId)
    const fromLog = scenariosFromLog(readInfoBoxesLogs(), listFlights(db), pointsFor)
    const fromHand = handScenarios().flatMap((hand) => {
      const flight = getFlight(db, hand.flightId)
      const scenario = flight ? scenarioFromHand(hand, flight, pointsFor(hand.flightId)) : null
      return scenario ? [scenario] : []
    })
    const scenarios: TaxiScenario[] = [...fromLog, ...fromHand].filter((sc) => sc.samples.length > 0).sort((a, b) => a.atMs - b.atMs)

    const outcomes: TaxiOutcome[] = scenarios.map((sc) => {
      const segments = listCachedTaxiSegments(db, sc.icao)
      const stands = listCachedStands(db, sc.icao)
      return { sc, segments, run: runTaxi(sc, segments, stands, true), baseline: runTaxi(sc, segments, stands, false) }
    })
    const results = outcomes.map(({ sc, run, baseline }) => ({
      id: sc.id,
      icao: sc.icao,
      clearance: sc.boxes.map((b) => b.info).join(' '),
      traced: run.cleared !== null,
      reroutes: run.reroutes.length,
      onLinePct: run.onLinePct,
      todayOnLinePct: baseline.onLinePct,
      endToAircraftM: run.endToAircraftM === null ? null : Math.round(run.endToAircraftM),
      notScored: sc.notScored ?? null
    }))
    const page = writeReport('taxi', taxiReport(outcomes), results)
    process.stdout.write(`\n${outcomes.length} taxis simulated. Report: ${page}\n`)
    console.table(results)
  } finally {
    close()
  }
})
