/**
 * Drives one deviation (taxi-fuzz.ts) through the real taxi line service, sample by sample, and judges how the line re-routes
 * (winglog-backend docs/plans/taxi-and-second-screen-robustness.md, stage 6d). Used by taxi-reroute-fuzz.sim.ts; the caller mocks the
 * app's logger (`vi.mock('../../src/main/logging/logger', ...)`), which this reads to see a re-route.
 */
import { vi } from 'vitest'
import type { BeyondAtcInfoBox, SimTelemetry } from '@shared/ipc'
import { EMPTY_BEYONDATC_STATE } from '@shared/beyondatc-state'
import type { TaxiRoute } from '@shared/live'
import { initialBearingDeg } from '@shared/geo'
import type { TaxiClearance } from '@shared/taxi/clearance'
import { routeProblems } from '@shared/taxi/route-checks'
import { angleBetweenDeg } from '@shared/taxi/route-graph'
import { LiveHub } from '../../src/main/live/LiveHub'
import { TaxiRouteService } from '../../src/main/taxi/TaxiRouteService'
import { logger } from '../../src/main/logging/logger'
import type { GeneratorAirport } from './taxi-generate'
import type { Deviation, Drive } from './taxi-fuzz'
import type { LonLat } from './svg'

export const MAX_REROUTE_S = 6
export const MAX_REROUTES_PER_MIN = 4
export const MAX_BEHIND_S = 4
/** Moving faster than this counts as moving, for the line pointing behind (m/s). */
const MOVING_MS = 1

export const FAILURES = [
  'late-reroute',
  'no-reroute',
  'reroute-with-problems',
  'too-many-reroutes',
  'points-behind',
  'line-lost'
] as const
export type Failure = (typeof FAILURES)[number]

export interface RunResult {
  id: string
  icao: string
  deviation: Deviation
  /** Seconds from leaving the route to the first re-route; null when it never came. */
  rerouteAfterS: number | null
  reroutes: number
  failures: Failure[]
  /** What was wrong with the re-routes that failed routeProblems. */
  problems: string[]
  /** The slowest sample, ms. */
  maxSampleMs: number
}

/**
 * @param c A clearance.
 * @returns The InfoBoxes BeyondATC would send for it.
 */
export function boxesFor(c: TaxiClearance): BeyondAtcInfoBox[] {
  const boxes: BeyondAtcInfoBox[] = []
  if (c.taxiToRunway) boxes.push({ title: 'Taxi to Runway', info: c.taxiToRunway })
  c.taxiways.forEach((t, i) => boxes.push({ title: `Taxi Via ${i + 1}`, info: t }))
  if (c.holdingPoint) boxes.push({ title: 'Hold Position', info: c.holdingPoint })
  if (c.holdShortRunway) boxes.push({ title: 'Hold Short', info: c.holdShortRunway })
  if (c.stand) boxes.push({ title: 'Taxi to Stand', info: `Stand ${c.stand}` })
  return boxes
}

/** Whether a line's first leg points behind the way the aircraft's nose points. */
function pointsBehind(line: LonLat[], headingDeg: number): boolean {
  if (line.length < 2) return false
  const bearing = initialBearingDeg(
    { lat: line[0][1], lon: line[0][0] },
    { lat: line[1][1], lon: line[1][0] }
  )
  return angleBetweenDeg(bearing, headingDeg) > 120
}

/**
 * Drives one deviation through a service.
 *
 * @param airport The airport.
 * @param id The run's name.
 * @param clearance The clearance the route was made from.
 * @param drive The driven track.
 * @returns The result, and the last line published.
 */
export async function runDrive(
  airport: GeneratorAirport,
  id: string,
  clearance: TaxiClearance,
  drive: Drive
): Promise<{ result: RunResult; lastLine: LonLat[] | null }> {
  const hub = new LiveHub()
  let published: TaxiRoute | null = null
  hub.subscribe((topic, payload) => {
    if (topic === 'taxiRoute') published = payload as TaxiRoute | null
  })
  let now = 0
  const service = new TaxiRouteService({
    hub,
    navdata: {
      getTaxiNetwork: () => airport.segments,
      listRunways: () => airport.runways,
      getStands: () => Promise.resolve(airport.stands),
      onAirportRefreshed: () => () => undefined
    },
    shownFlight: () => ({ flightId: 1, depIcao: airport.icao, arrIcao: airport.icao, ofpJson: null }),
    active: () => ({ flightId: 1, phase: 'taxi' }),
    now: () => now
  })
  const stop = service.start()
  const telemetry = (s: Drive['samples'][number], heading: number): void => {
    now = s.t * 1000
    hub.publish('simTelemetry', {
      latitude: s.lat,
      longitude: s.lon,
      headingTrueDeg: heading,
      groundSpeedMs: s.groundSpeedMs
    } as SimTelemetry)
  }
  const failures = new Set<Failure>()
  const problemCodes = new Set<string>()
  const rerouteTimes: number[] = []
  let maxSampleMs = 0
  let behindRun = 0
  let drawn = false
  try {
    telemetry(drive.samples[0], drive.startHeadingDeg)
    hub.publish('beyondAtcState', { ...EMPTY_BEYONDATC_STATE, infoBoxes: boxesFor(clearance) })
    await new Promise((r) => setTimeout(r, 0))
    for (const s of drive.samples.slice(1)) {
      const before = vi.mocked(logger.info).mock.calls.length
      const startedAt = performance.now()
      telemetry(s, s.headingDeg)
      maxSampleMs = Math.max(maxSampleMs, performance.now() - startedAt)
      const rerouted = vi
        .mocked(logger.info)
        .mock.calls.slice(before)
        .some((call) => String(call[0]).includes('re-routed'))
      const route = published as TaxiRoute | null
      if (route && route.line.length >= 2) {
        drawn = true
        if (rerouted) {
          rerouteTimes.push(s.t)
          const end = route.line[route.line.length - 1]
          const problems = routeProblems(route.line, {
            segments: airport.segments,
            taxiways: [],
            holdingPoint: null,
            from: { lat: s.lat, lon: s.lon },
            end: { lat: end[1], lon: end[0] },
            headingDeg: null
          })
          if (problems.length > 0) {
            failures.add('reroute-with-problems')
            problems.forEach((p) => problemCodes.add(p))
          }
        }
        behindRun = s.groundSpeedMs > MOVING_MS && pointsBehind(route.line, s.headingDeg) ? behindRun + 1 : 0
        if (behindRun > MAX_BEHIND_S) failures.add('points-behind')
      } else if (drawn && s.groundSpeedMs > MOVING_MS && !route) {
        failures.add('line-lost')
      }
    }
  } finally {
    stop()
  }
  const left = drive.samples[drive.leftAtIndex].t
  // The first re-route of the run, which can come before the aircraft has been 40 m off for 6 s (the "passed" rule re-routes sooner): early is fine.
  const rerouteAfterS = rerouteTimes.length === 0 ? null : rerouteTimes[0] - left
  // A wrong-way start needs no re-route: the first line already starts the way the nose points.
  if (drive.deviation !== 'wrong-way-start') {
    if (rerouteAfterS === null) failures.add('no-reroute')
    else if (rerouteAfterS > MAX_REROUTE_S) failures.add('late-reroute')
  }
  for (const t of rerouteTimes)
    if (rerouteTimes.filter((u) => u >= t && u < t + 60).length > MAX_REROUTES_PER_MIN)
      failures.add('too-many-reroutes')
  const last = published as TaxiRoute | null
  return {
    lastLine: last?.line ?? null,
    result: {
      id,
      icao: airport.icao,
      deviation: drive.deviation,
      rerouteAfterS,
      reroutes: rerouteTimes.length,
      failures: [...failures],
      problems: [...problemCodes],
      maxSampleMs: Math.round(maxSampleMs * 10) / 10
    }
  }
}
