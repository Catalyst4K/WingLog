/**
 * `npm run sim -- taxi`: the taxi line simulation on this machine's real taxis. Reads WingLog's
 * database and logs read-only and writes release/sim/taxi/index.html (gitignored). Not part of
 * `npm test`: it needs local data (winglog-backend docs/plans/robustness/scenario-testing.md
 * Part 6).
 *
 * Taxis from before the InfoBoxes were logged can be added by hand in
 * release/sim/taxi/hand-scenarios.json, a list of HandScenario (taxi.ts).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'vitest'
import { getFlight, listFlights } from '../../src/main/db/flight-repo'
import { listCachedRunways, listCachedStands, listCachedTaxiSegments } from '../../src/main/db/navdata-repo'
import { listTrackPoints } from '../../src/main/db/track-point-repo'
import { openUserDb, readInfoBoxesLogs } from './local-data'
import { renderReport, simOutputDir, writeReport } from './report'
import { taxiCompareReport } from './taxi-compare-report'
import {
  runTaxi,
  scenarioFromHand,
  scenariosFromLog,
  type HandScenario,
  type TaxiRun,
  type TaxiScenario
} from './taxi'
import { flatDistanceM } from '../../src/shared/geo'
import type { TracedRoute } from '../../src/shared/taxi/route-trace'
import { taxiReport, type TaxiOutcome } from './taxi-report'

function handScenarios(): HandScenario[] {
  const path = join(simOutputDir('taxi'), 'hand-scenarios.json')
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as HandScenario[]) : []
}

/**
 * Prints how the pathfinder's line compares with the traced one for a taxi: how far apart the two ends are and how much longer the
 * pathfinder's way is. The fallback is only as good as it is close to the real route.
 *
 * @param id The taxi's id.
 * @param run The taxi as played.
 */
function logPathfinderAgainstTrace(
  id: string,
  run: TaxiRun,
  last: { lat: number; lon: number } | null
): void {
  const exact = run.exact
  const found = run.pathfinder
  if (!exact) return
  if (!found) {
    process.stdout.write(`PATHFINDER found nothing for ${id}
`)
    return
  }
  const end = (route: TracedRoute): { lat: number; lon: number } => ({
    lat: route.at(-1)?.[1] ?? 0,
    lon: route.at(-1)?.[0] ?? 0
  })
  const length = (route: TracedRoute): number =>
    route
      .slice(1)
      .reduce(
        (sum, p, i) => sum + flatDistanceM({ lat: route[i][1], lon: route[i][0] }, { lat: p[1], lon: p[0] }),
        0
      )
  const apart = Math.round(flatDistanceM(end(exact), end(found)))
  const ratio = (length(found) / Math.max(1, length(exact))).toFixed(2)
  const toReal = (route: TracedRoute): string =>
    last ? String(Math.round(flatDistanceM(end(route), last))) : 'n/a'
  const startApart = Math.round(
    flatDistanceM({ lat: exact[0][1], lon: exact[0][0] }, { lat: found[0][1], lon: found[0][0] })
  )
  process.stdout.write(
    `PATHFINDER vs TRACE ${id}: starts ${startApart} m apart, ends ${apart} m apart, length ${Math.round(length(exact))} m main / ${Math.round(length(found))} m fallback (x${ratio}), end to the real taxi's last point: main ${toReal(exact)} m, fallback ${toReal(found)} m
`
  )
}

it('simulates the taxi line on real taxis', () => {
  const { db, close } = openUserDb()
  try {
    const pointsFor = (flightId: number) => listTrackPoints(db, flightId)
    const fromLog = scenariosFromLog(readInfoBoxesLogs(), listFlights(db), pointsFor)
    const fromHand = handScenarios().flatMap((hand) => {
      const flight = getFlight(db, hand.flightId)
      const scenario = flight
        ? scenarioFromHand(
            hand,
            flight,
            pointsFor(hand.flightId),
            listCachedRunways(db, hand.side === 'out' ? (flight.depIcao ?? '') : (flight.arrIcao ?? ''))
          )
        : null
      return scenario ? [scenario] : []
    })
    const scenarios: TaxiScenario[] = [...fromLog, ...fromHand]
      .filter((sc) => sc.samples.length > 0)
      .sort((a, b) => a.atMs - b.atMs)

    const outcomes: TaxiOutcome[] = scenarios.map((sc) => {
      const segments = listCachedTaxiSegments(db, sc.icao)
      const stands = listCachedStands(db, sc.icao)
      const runways = listCachedRunways(db, sc.icao)
      const without = runTaxi(sc, segments, stands, true)
      const run = runTaxi(sc, segments, stands, true, runways)
      const a = without.cleared?.at(-1)
      const b = run.cleared?.at(-1)
      if (a && b && (a[0] !== b[0] || a[1] !== b[1]))
        process.stdout
          .write(`RUNWAY RULE MOVED THE END ${sc.id} ${sc.icao}: ${a[1].toFixed(5)},${a[0].toFixed(5)} -> ${b[1].toFixed(5)},${b[0].toFixed(5)}
`)
      return {
        sc,
        segments,
        run,
        baseline: runTaxi(sc, segments, stands, false)
      }
    })
    for (const { sc, run } of outcomes) {
      const end = sc.samples.filter((s) => s.phase !== 'takeoff').at(-1) ?? null
      logPathfinderAgainstTrace(sc.id, run, end)
    }
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
    writeFileSync(join(simOutputDir('taxi'), 'compare.html'), renderReport(taxiCompareReport(outcomes)))
    process.stdout.write(`\n${outcomes.length} taxis simulated. Report: ${page}\n`)
    console.table(results)
  } finally {
    close()
  }
})
