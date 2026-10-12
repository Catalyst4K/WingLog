/**
 * Scenario tests: real recordings, varied on purpose, run through the real app, checked by rules
 * (winglog-backend docs/plans/robustness/scenario-testing.md Part 2). One per bug found by
 * flying since 2026-10-05; each also runs the unvaried base, so a rule that fails on the base is
 * a bug in the rule, not the app.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseAtcTaxiFacts } from '../../src/shared/atc-info-boxes'
import { listLandingsByFlight } from '../../src/main/db/landing-repo'
import {
  EGLL_RUNWAYS,
  EGLL_TAXI_OUT,
  egllEgcc,
  seedApproaches,
  seedRunways,
  withArrival,
  WSSS_ARRIVAL,
  WSSS_RUNWAYS,
  wsssDescent,
  wsssLanding,
  zjsyArrival
} from './bases'
import { runScenario, type ScenarioResult } from './harness'
import {
  arrivalCardPrompt,
  arrivalCardUntilTouchdown,
  gateWithItsBox,
  neverAirbornePhaseOnGround,
  takeoffOnlyOnRunway,
  taxiAfterLanding
} from './rules'
import {
  applyTransforms,
  bounceOnRollout,
  changeClearedRunway,
  dropAtcLine,
  duplicateAtcLine,
  renameTaxiway,
  speedUpTaxi,
  stallFieldUpdates,
  type Transform
} from './transforms'

/** A whole flight replays in a few seconds; this is headroom for a slow CI runner. */
const SCENARIO_TIMEOUT_MS = 60_000

afterEach(() => {
  vi.useRealTimers()
})

/** EGLL to EGCC with EGLL's runways cached, varied by `transforms`. */
function egllFlight(transforms: Transform[]): Promise<ScenarioResult> {
  vi.useFakeTimers({ toFake: ['Date'] })
  return runScenario(applyTransforms(egllEgcc(), transforms), {
    depIcao: 'EGLL',
    arrIcao: 'EGCC',
    seed: (db) => seedRunways(db, 'EGLL', EGLL_RUNWAYS),
    setClock: (ms) => vi.setSystemTime(ms)
  })
}

/** The same flight with flight 230's ZJSY arrival boxes, and ZJSY's approaches cached. */
function zjsyArrivalFlight(transforms: Transform[]): Promise<ScenarioResult> {
  vi.useFakeTimers({ toFake: ['Date'] })
  const arrival = zjsyArrival()
  return runScenario(applyTransforms(withArrival(egllEgcc(), arrival), transforms), {
    depIcao: 'EGLL',
    arrIcao: arrival.arrivalIcao,
    seed: (db) => {
      seedRunways(db, 'EGLL', EGLL_RUNWAYS)
      seedApproaches(db, arrival)
    },
    setClock: (ms) => vi.setSystemTime(ms)
  })
}

describe('scenario: fast taxi on a parallel taxiway (flight 230, VHHH)', () => {
  it(
    'never starts the takeoff phase off a runway, at normal or four times taxi speed',
    async () => {
      for (const transforms of [[], [speedUpTaxi(EGLL_TAXI_OUT, 4)]]) {
        const { samples, flight } = await egllFlight(transforms)
        expect(takeoffOnlyOnRunway(samples, EGLL_RUNWAYS)).toEqual([])
        expect(samples.some((s) => s.phase === 'takeoff')).toBe(true)
        expect(flight?.actualOffUtc).toBeTruthy()
      }
    },
    SCENARIO_TIMEOUT_MS
  )

  it(
    'really is a fast taxi: well above the takeoff-roll speed, off the runways',
    async () => {
      const varied = applyTransforms(egllEgcc(), [speedUpTaxi(EGLL_TAXI_OUT, 4)])
      const fastOffRunway = varied.events.filter(
        (e) =>
          e.type === 'telemetry' &&
          e.tOffsetMs <= EGLL_TAXI_OUT.fromMs + (EGLL_TAXI_OUT.toMs - EGLL_TAXI_OUT.fromMs) / 4 &&
          e.tOffsetMs >= EGLL_TAXI_OUT.fromMs &&
          e.data.groundSpeedMs > 18
      )
      expect(fastOffRunway.length).toBeGreaterThan(5)
    },
    SCENARIO_TIMEOUT_MS
  )
})

describe('scenario: bounce on the rollout (flight 227, #108)', () => {
  it(
    'rides out a bounce of up to five seconds and gets back to taxi',
    async () => {
      for (const transforms of [[], [bounceOnRollout(2)], [bounceOnRollout(5, 3)]]) {
        const { samples } = await egllFlight(transforms)
        expect(neverAirbornePhaseOnGround(samples)).toEqual([])
        expect(taxiAfterLanding(samples)).toEqual([])
      }
    },
    SCENARIO_TIMEOUT_MS
  )
})

describe('scenario: the arrival clearance (#109, #110)', () => {
  it(
    'keeps the STAR, runway and approach on the card until touchdown, for either runway',
    async () => {
      const base = await zjsyArrivalFlight([])
      expect(arrivalCardUntilTouchdown(base.samples, '08')).toEqual([])
      const beforeTouchdown = base.samples.filter((s) => s.arrival !== null).at(-1)?.arrival
      expect(beforeTouchdown).toEqual({
        starIdent: 'UPRS2C',
        runway: '08',
        approachIdent: 'ILS Z 08',
        approachTransition: 'SY498'
      })

      const other = await zjsyArrivalFlight([changeClearedRunway('08', '26')])
      expect(arrivalCardUntilTouchdown(other.samples, '26')).toEqual([])
    },
    SCENARIO_TIMEOUT_MS
  )

  it(
    'keeps the card through missed, repeated and late transmissions',
    async () => {
      const variations: Transform[][] = [
        [dropAtcLine(/Maintain Speed|Reduce Speed|Descend to/)],
        [duplicateAtcLine(/STAR|Cleared Approach/)],
        [stallFieldUpdates('beyondatc', 45)]
      ]
      for (const transforms of variations) {
        const { samples } = await zjsyArrivalFlight(transforms)
        expect(arrivalCardUntilTouchdown(samples, '08')).toEqual([])
      }
    },
    SCENARIO_TIMEOUT_MS
  )
})

describe('scenario: the gate and taxi boxes after landing (#111, #112)', () => {
  it(
    'knows the gate as soon as a box names it',
    async () => {
      const { samples } = await zjsyArrivalFlight([])
      expect(gateWithItsBox(samples, '102')).toEqual([])
    },
    SCENARIO_TIMEOUT_MS
  )

  it(
    'reads a taxiway named with a space as one taxiway',
    async () => {
      const { samples } = await zjsyArrivalFlight([renameTaxiway('A4', 'LINK 36')])
      const taxiBoxes = samples.find((s) => s.infoBoxes.some((b) => b.title === 'Taxi to Gate'))
      expect(taxiBoxes && parseAtcTaxiFacts(taxiBoxes.infoBoxes).taxiVia).toEqual(['LINK 36', 'D'])
    },
    SCENARIO_TIMEOUT_MS
  )
})

describe('scenario: a landing on a runway the sim places differently (flight 236, WSSS 20R)', () => {
  /** The A380's touchdown, replayed with the sim's own WSSS runways cached. */
  async function wsssLandingRun(): Promise<ReturnType<typeof listLandingsByFlight>> {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { db, flightId } = await runScenario(wsssLanding(), {
      depIcao: 'WSSS',
      arrIcao: 'WSSS',
      seed: (seeded) => seedRunways(seeded, 'WSSS', WSSS_RUNWAYS),
      setClock: (ms) => vi.setSystemTime(ms)
    })
    return listLandingsByFlight(db, flightId)
  }

  it(
    'records one landing on 20R, with its runway and offset',
    async () => {
      const landings = await wsssLandingRun()
      expect(landings).toHaveLength(1)
      expect(landings[0].icao).toBe('WSSS')
      expect(landings[0].runwayIdent).toBe('20R')
      expect(landings[0].centrelineOffsetM).not.toBeNull()
    },
    SCENARIO_TIMEOUT_MS
  )

  // The aircraft touched down 1.9 m left of the sim's 20R centreline. The landing record measures
  // against OurAirports' 20R, 40 m away, and says 38 m right. Known bug, planned as
  // winglog-backend docs/plans/landing-runway-from-sim.md: `it.fails` turns red the moment the fix
  // lands, and the `.fails` comes off then.
  it.fails(
    "measures the centreline offset against the sim's runway (within 10 m of -1.9 m)",
    async () => {
      const [landing] = await wsssLandingRun()
      expect(Math.abs((landing.centrelineOffsetM ?? 99) - -1.9)).toBeLessThan(10)
    },
    SCENARIO_TIMEOUT_MS
  )
})

describe('scenario: the descent after BeyondATC went silent (flight 236, WSSS 20R)', () => {
  /** The real last 36 minutes, varied by `transforms`, with WSSS's runways and approaches cached. */
  function wsssDescentFlight(transforms: Transform[]): Promise<ScenarioResult> {
    vi.useFakeTimers({ toFake: ['Date'] })
    return runScenario(applyTransforms(wsssDescent(), transforms), {
      depIcao: 'EGLL',
      arrIcao: 'WSSS',
      seed: (db) => {
        seedRunways(db, 'WSSS', WSSS_RUNWAYS)
        seedApproaches(db, WSSS_ARRIVAL)
      },
      setClock: (ms) => vi.setSystemTime(ms)
    })
  }

  it(
    'shows the arrival card with the STAR clearance, on 20R, until touchdown',
    async () => {
      const { samples } = await wsssDescentFlight([])
      expect(arrivalCardUntilTouchdown(samples, '20R')).toEqual([])
      expect(arrivalCardPrompt(samples, 60)).toEqual([])
    },
    SCENARIO_TIMEOUT_MS
  )

  it(
    'keeps the card through missed, repeated and late transmissions',
    async () => {
      const variations: Transform[][] = [
        [dropAtcLine(/Descend to|Cross BIPOP/)],
        [duplicateAtcLine(/STAR|Cleared Approach/)],
        [stallFieldUpdates('beyondatc', 45)]
      ]
      for (const transforms of variations) {
        const { samples } = await wsssDescentFlight(transforms)
        expect(arrivalCardUntilTouchdown(samples, '20R')).toEqual([])
      }
    },
    SCENARIO_TIMEOUT_MS
  )

  it(
    'follows the runway when ATC changes it mid-descent',
    async () => {
      const { samples } = await wsssDescentFlight([changeClearedRunway('20R', '20C')])
      expect(arrivalCardUntilTouchdown(samples, '20C')).toEqual([])
    },
    SCENARIO_TIMEOUT_MS
  )
})
