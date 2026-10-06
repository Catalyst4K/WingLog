/**
 * The real recordings scenarios start from, and the cached navdata they need
 * (winglog-backend docs/plans/robustness/scenario-testing.md Part 2). All committed data here
 * is real and anonymised.
 */
import { readFileSync } from 'node:fs'
import type { WingLogDb } from '../../src/main/db/client'
import { navdataProcedure, navdataRunway } from '../../src/main/db/schema'
import { parseFlightFixture, type FlightFixtureEvent, type ParsedFlightFixture } from '../../src/main/sim/flight-fixture'
import type { NavdataRunway } from '../../src/main/navdata/navdata-provider'

function readRepoFile(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'utf8')
}

/** EGLL to EGCC in a Fenix A320, pushback to shutdown, 1 Hz (src/main/tracking/__fixtures__). */
export function egllEgcc(): ParsedFlightFixture {
  return parseFlightFixture(readRepoFile('src/main/tracking/__fixtures__/short-hop-egll-egcc.ndjson'))
}

/** EGLL's runways from the sim's navdata cache, as fetched 2026-10. */
export const EGLL_RUNWAYS: NavdataRunway[] = [
  { ident: '09L', headingTrueDeg: 89.68263244628906, lengthM: 3901.17, widthM: 49.84, surface: 0, thresholdLat: 51.47749403978207, thresholdLon: -0.48948362274299706 },
  { ident: '27R', headingTrueDeg: 269.68263244628906, lengthM: 3901.17, widthM: 49.84, surface: 0, thresholdLat: 51.477688154927705, thresholdLon: -0.4332168419824973 },
  { ident: '09R', headingTrueDeg: 89.7060546875, lengthM: 3659.1, widthM: 50, surface: 0, thresholdLat: 51.46478305178305, thresholdLon: -0.48678691940122426 },
  { ident: '27L', headingTrueDeg: 269.7060546875, lengthM: 3659.1, widthM: 50, surface: 0, thresholdLat: 51.46495168489793, thresholdLon: -0.4340261642474574 }
]

/** The EGLL fixture's taxi out: first movement to just before lining up on 27L. */
export const EGLL_TAXI_OUT = { fromMs: 983_942, toMs: 1_525_000 }

interface ArrivalTimeline {
  arrivalIcao: string
  approaches: { identifier: string; runways: string[]; transitions: string[] }[]
  beyondatc: { secondsFromTouchdown: number; text: string }[]
}

/** BeyondATC's InfoBoxes for flight 230's ZJSY arrival (2026-10-05), timed from touchdown. */
export function zjsyArrival(): ArrivalTimeline {
  return JSON.parse(readRepoFile('scripts/scenarios/__fixtures__/zjsy-230-arrival.json')) as ArrivalTimeline
}

/** The offset of the first touchdown after flight, in ms. */
export function touchdownOffsetMs(capture: ParsedFlightFixture): number {
  let airborne = 0
  for (const e of capture.events) {
    if (e.type !== 'telemetry') continue
    if (!e.data.onGround) airborne++
    else if (airborne >= 3) return e.tOffsetMs
  }
  throw new Error(`${capture.header.scenario} has no touchdown`)
}

/**
 * A real BeyondATC arrival laid over a real flight's telemetry, lined up on touchdown: the
 * multi-stream capture this branch can build before the dev build has recorded one. The
 * telemetry is another airport's, so only rules about timing relative to the flight hold.
 */
export function withArrival(flight: ParsedFlightFixture, arrival: ArrivalTimeline): ParsedFlightFixture {
  const touchdown = touchdownOffsetMs(flight)
  const lines: FlightFixtureEvent[] = arrival.beyondatc.map((line) => ({
    type: 'beyondatc',
    tOffsetMs: Math.round(touchdown + line.secondsFromTouchdown * 1000),
    direction: 'in',
    text: line.text
  }))
  return {
    header: { ...flight.header, scenario: `${flight.header.scenario} + ${arrival.arrivalIcao} arrival boxes` },
    events: [...flight.events, ...lines].sort((a, b) => a.tOffsetMs - b.tOffsetMs)
  }
}

/** Caches runways for an airport. */
export function seedRunways(db: WingLogDb, icao: string, runways: NavdataRunway[]): void {
  for (const runway of runways) {
    db.insert(navdataRunway).values({ icao, source: 'sim-facility', fetchedAt: '2026-10-05T00:00:00Z', ...runway }).run()
  }
}

/** Caches an arrival's approaches. */
export function seedApproaches(db: WingLogDb, arrival: ArrivalTimeline): void {
  for (const approach of arrival.approaches) {
    db.insert(navdataProcedure)
      .values({
        icao: arrival.arrivalIcao,
        kind: 'approach',
        identifier: approach.identifier,
        runwayIdentsJson: JSON.stringify(approach.runways),
        transitionNamesJson: JSON.stringify(approach.transitions),
        source: 'sim-facility',
        fetchedAt: '2026-10-05T00:00:00Z'
      })
      .run()
  }
}
