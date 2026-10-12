/**
 * The real recordings scenarios start from, and the cached navdata they need
 * (winglog-backend docs/plans/robustness/scenario-testing.md Part 2). All committed data here
 * is real and anonymised.
 */
import { readFileSync } from 'node:fs'
import type { WingLogDb } from '../../src/main/db/client'
import { navdataProcedure, navdataRunway } from '../../src/main/db/schema'
import {
  parseFlightFixture,
  type FlightFixtureEvent,
  type ParsedFlightFixture
} from '../../src/main/sim/flight-fixture'
import type { NavdataRunway } from '../../src/main/navdata/navdata-provider'

function readRepoFile(path: string): string {
  return readFileSync(
    new URL(`../../${path}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    'utf8'
  )
}

/** EGLL to EGCC in a Fenix A320, pushback to shutdown, 1 Hz (src/main/tracking/__fixtures__). */
export function egllEgcc(): ParsedFlightFixture {
  return parseFlightFixture(readRepoFile('src/main/tracking/__fixtures__/short-hop-egll-egcc.ndjson'))
}

/** EGLL's runways from the sim's navdata cache, as fetched 2026-10. */
export const EGLL_RUNWAYS: NavdataRunway[] = [
  {
    ident: '09L',
    headingTrueDeg: 89.68263244628906,
    lengthM: 3901.17,
    widthM: 49.84,
    surface: 0,
    thresholdLat: 51.47749403978207,
    thresholdLon: -0.48948362274299706
  },
  {
    ident: '27R',
    headingTrueDeg: 269.68263244628906,
    lengthM: 3901.17,
    widthM: 49.84,
    surface: 0,
    thresholdLat: 51.477688154927705,
    thresholdLon: -0.4332168419824973
  },
  {
    ident: '09R',
    headingTrueDeg: 89.7060546875,
    lengthM: 3659.1,
    widthM: 50,
    surface: 0,
    thresholdLat: 51.46478305178305,
    thresholdLon: -0.48678691940122426
  },
  {
    ident: '27L',
    headingTrueDeg: 269.7060546875,
    lengthM: 3659.1,
    widthM: 50,
    surface: 0,
    thresholdLat: 51.46495168489793,
    thresholdLon: -0.4340261642474574
  }
]

/** The EGLL fixture's taxi out: first movement to just before lining up on 27L. */
export const EGLL_TAXI_OUT = { fromMs: 983_942, toMs: 1_525_000 }

export interface ArrivalTimeline {
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
    header: {
      ...flight.header,
      scenario: `${flight.header.scenario} + ${arrival.arrivalIcao} arrival boxes`
    },
    events: [...flight.events, ...lines].sort((a, b) => a.tOffsetMs - b.tOffsetMs)
  }
}

/** Caches runways for an airport. */
export function seedRunways(db: WingLogDb, icao: string, runways: NavdataRunway[]): void {
  for (const runway of runways) {
    db.insert(navdataRunway)
      .values({ icao, source: 'sim-facility', fetchedAt: '2026-10-05T00:00:00Z', ...runway })
      .run()
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

/** A380 final approach and touchdown on WSSS 20R, 2.5 minutes of 1 Hz telemetry (flight 236, 2026-10-12). */
export function wsssLanding(): ParsedFlightFixture {
  return parseFlightFixture(readRepoFile('scripts/scenarios/__fixtures__/wsss-236-landing.ndjson'))
}

/**
 * WSSS's 20R and its reciprocal 02L from the sim's navdata cache, fetched 2026-10-12. The sim's 20R
 * threshold is about 820 m past OurAirports' physical end and about 40 m to its west: the same strip,
 * placed differently (WingLog docs/plans/landing-runway-from-sim.md).
 */
export const WSSS_RUNWAYS: NavdataRunway[] = [
  {
    ident: '20R',
    headingTrueDeg: 203,
    lengthM: 3221.21826171875,
    widthM: 60,
    surface: 4,
    thresholdLat: 1.3757575921283205,
    thresholdLon: 103.98878019536174
  },
  {
    ident: '02L',
    headingTrueDeg: 23,
    lengthM: 3221.21826171875,
    widthM: 60,
    surface: 4,
    thresholdLat: 1.3491213448776762,
    thresholdLon: 103.97747058188283
  }
]

/**
 * The last 36 minutes of flight 236 into WSSS 20R, with BeyondATC's real stream: the descent
 * clearances that arrived in one burst after 73 minutes of silence (2026-10-12). The first real
 * dev-build capture in the scenario base set.
 */
export function wsssDescent(): ParsedFlightFixture {
  return parseFlightFixture(readRepoFile('scripts/scenarios/__fixtures__/wsss-236-descent.ndjson'))
}

/** WSSS's approaches to 20R from the sim's navdata cache, fetched 2026-10-12, for the arrival card. */
export const WSSS_ARRIVAL: ArrivalTimeline = {
  arrivalIcao: 'WSSS',
  approaches: [
    { identifier: 'ILS 20R', runways: ['20R'], transitions: ['IPNAK'] },
    { identifier: 'RNAV 20R', runways: ['20R'], transitions: ['BIDUS', 'BIPOP', 'NYLON'] }
  ],
  beyondatc: []
}
