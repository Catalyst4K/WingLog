/**
 * `npm run sim -- flight`: replays a dev-build capture of a whole flight through the real app and
 * checks it (winglog-backend docs/plans/robustness/scenario-testing.md Parts 1 and 6). Reads the
 * newest capture in WingLog's data folder, or WINGLOG_SIM_CAPTURE, and WingLog's database
 * read-only; writes release/sim/flight/index.html (gitignored: it shows a real flight). Not part of
 * `npm test`: it needs a capture.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { it, vi } from 'vitest'
import { findRunwayEndByIdent } from '../../src/main/airports/runway-lookup'
import type { WingLogDb } from '../../src/main/db/client'
import { getFlight } from '../../src/main/db/flight-repo'
import { listLandingsByFlight } from '../../src/main/db/landing-repo'
import { listCachedRunways } from '../../src/main/db/navdata-repo'
import { listTrackPoints } from '../../src/main/db/track-point-repo'
import { navdataProcedure, navdataRunway } from '../../src/main/db/schema'
import { parseFlightFixture } from '../../src/main/sim/flight-fixture'
import { runScenario } from '../scenarios/harness'
import {
  arrivalCardPrompt,
  arrivalCardUntilTouchdown,
  landingMatchesSimRunway,
  neverAirbornePhaseOnGround,
  samePhasesAsLive,
  takeoffOnlyOnRunway,
  taxiAfterLanding
} from '../scenarios/rules'
import { touchdownOffsetMs } from '../scenarios/bases'
import {
  LONG_ATC_SILENCE_MS,
  atcSilences,
  databaseRunwayLine,
  findCapture,
  phaseFlicker,
  phaseSequence,
  phaseSpans,
  simRunwayLine,
  trackOf
} from './flight'
import { flightReport, type FlightFindings } from './flight-report'
import { openUserDb, userDataDir } from './local-data'
import { simOutputDir, writeReport } from './report'
import { positionRelativeToRunway } from '../../src/main/airports/landing-maths'

/** Copies the airports' cached runways and procedures into the scenario's database, ids and all. */
function copyNavdata(from: WingLogDb, to: WingLogDb, icaos: string[]): void {
  for (const icao of icaos) {
    for (const row of from.select().from(navdataRunway).where(eq(navdataRunway.icao, icao)).all())
      to.insert(navdataRunway).values(row).run()
    for (const row of from.select().from(navdataProcedure).where(eq(navdataProcedure.icao, icao)).all())
      to.insert(navdataProcedure).values(row).run()
  }
}

it('simulates a recorded flight', async () => {
  const dataDir = userDataDir()
  const capturePath = findCapture(dataDir, process.env.WINGLOG_SIM_CAPTURE)
  const capture = parseFlightFixture(readFileSync(capturePath, 'utf8'))
  const { db: userDb, close } = openUserDb()
  try {
    const liveFlightId = (capture.header as { flightId?: number }).flightId
    const live = liveFlightId === undefined ? undefined : getFlight(userDb, liveFlightId)
    const depIcao = live?.depIcao ?? process.env.WINGLOG_SIM_DEP
    const arrIcao = live?.arrIcao ?? process.env.WINGLOG_SIM_ARR
    if (!depIcao || !arrIcao)
      throw new Error('The capture has no flight in the database: set WINGLOG_SIM_DEP and WINGLOG_SIM_ARR')

    vi.useFakeTimers({ toFake: ['Date'] })
    const result = await runScenario(capture, {
      depIcao,
      arrIcao,
      seed: (db) => copyNavdata(userDb, db, [depIcao, arrIcao]),
      setClock: (ms) => vi.setSystemTime(ms)
    })
    vi.useRealTimers()
    const { samples } = result

    const track = trackOf(capture)
    const touchdownMs = touchdownOffsetMs(capture)
    const touchdownTick = track.find((t) => t.tOffsetMs >= touchdownMs)
    const landing = listLandingsByFlight(result.db, result.flightId)[0]
    const arrivalRunways = listCachedRunways(userDb, arrIcao)
    const simLine = landing?.runwayIdent ? simRunwayLine(arrivalRunways, landing.runwayIdent) : null
    const databaseEnd =
      landing?.icao && landing.runwayIdent ? findRunwayEndByIdent(landing.icao, landing.runwayIdent) : null
    const databaseLine = databaseEnd ? databaseRunwayLine(databaseEnd) : null
    const measured =
      simLine && touchdownTick
        ? positionRelativeToRunway(
            touchdownTick.latitude,
            touchdownTick.longitude,
            simLine.thresholdLat,
            simLine.thresholdLon,
            simLine.headingTrueDeg
          )
        : null

    const replayPhases = phaseSequence(samples.map((s) => s.phase))
    const livePhases = phaseSequence(listTrackPoints(userDb, liveFlightId ?? -1).map((p) => p.phase))
    const silences = atcSilences(capture.events, LONG_ATC_SILENCE_MS)
    const clearedRunway = landing?.runwayIdent ?? ''
    const depRunways = listCachedRunways(userDb, depIcao)

    const rules: FlightFindings['rules'] = [
      { name: 'Takeoff starts only on a runway', broken: takeoffOnlyOnRunway(samples, depRunways) },
      { name: 'No climb or cruise phase on the ground', broken: neverAirbornePhaseOnGround(samples) },
      {
        name: 'No climb or descent blip between cruise spans (under 60 s)',
        broken: phaseFlicker(phaseSpans(samples), 60_000)
      },
      { name: 'Back to taxi after landing', broken: taxiAfterLanding(samples) },
      {
        name: 'Arrival card kept until touchdown, on the cleared runway',
        broken: arrivalCardUntilTouchdown(samples, clearedRunway)
      },
      { name: 'Arrival card appears within 60 s of the clearance', broken: arrivalCardPrompt(samples, 60) },
      {
        name: "The landing agrees with the sim's runway (10 m)",
        broken:
          landing && measured
            ? landingMatchesSimRunway(
                {
                  recordedRunway: landing.runwayIdent,
                  recordedOffsetM: landing.centrelineOffsetM,
                  recordedDistanceM: landing.distanceFromThresholdM,
                  measuredOffsetM: measured.centrelineOffsetM,
                  measuredDistanceM: measured.distanceFromThresholdM
                },
                10
              )
            : ['no landing, or no cached sim runway, to compare']
      },
      {
        name: "Replay reaches the live flight's phases",
        broken: livePhases.length
          ? samePhasesAsLive(replayPhases, livePhases)
          : ['no live track points to compare']
      }
    ]

    const screensDir = join(simOutputDir('flight'), 'screens')
    const findings: FlightFindings = {
      scenario: capture.header.scenario,
      aircraft: capture.header.aircraftType,
      depIcao,
      arrIcao,
      capturedAt: capture.header.capturedAt,
      durationMs: capture.events[capture.events.length - 1].tOffsetMs,
      track,
      touchdownMs,
      spans: phaseSpans(samples),
      silences,
      nothingTunedAtMs: capture.events
        .filter(
          (e) =>
            e.type === 'beyondatc' &&
            e.direction === 'in' &&
            e.tOffsetMs > 60_000 &&
            e.text === 'Facility: Nothing Tuned'
        )
        .map((e) => e.tOffsetMs),
      atcLines: capture.events.flatMap((e) =>
        e.type === 'beyondatc' && e.direction === 'in' && e.text.startsWith('ATC: ')
          ? [{ tOffsetMs: e.tOffsetMs, text: e.text.slice(5) }]
          : []
      ),
      samples,
      landing: landing
        ? {
            runway: landing.runwayIdent,
            offsetM: landing.centrelineOffsetM,
            distanceM: landing.distanceFromThresholdM,
            verticalSpeedMs: landing.verticalSpeedMs,
            touchdownAtMs: touchdownMs
          }
        : null,
      simLine,
      databaseLine,
      measured,
      replayPhases,
      livePhases,
      rules,
      screens: existsSync(screensDir)
        ? readdirSync(screensDir)
            .filter((f) => f.endsWith('.png'))
            .sort()
        : []
    }
    const page = writeReport('flight', flightReport(findings), {
      capture: capturePath,
      rules: rules.map((r) => ({ name: r.name, broken: r.broken })),
      landing: findings.landing,
      measured,
      silences,
      spans: findings.spans,
      replayPhases,
      livePhases
    })
    process.stdout.write(`\nReport: ${page}\n`)
    for (const rule of rules)
      process.stdout.write(
        `${rule.broken.length === 0 ? 'PASS' : 'FAIL'}  ${rule.name}\n${rule.broken.map((b) => `        ${b}\n`).join('')}`
      )
  } finally {
    close()
    vi.useRealTimers()
  }
})
