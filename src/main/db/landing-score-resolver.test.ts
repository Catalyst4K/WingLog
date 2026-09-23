import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { Landing, LandingScoreCategoryKey } from '@shared/ipc'
import { computeLandingScore, type LandingScoreInputs } from '@shared/landing-score'
import { createAircraft } from './aircraft-repo'
import { createDb, type WingLogDb } from './client'
import { completeFlight, createFlight, createFreeFlight } from './flight-repo'
import { createLanding, type NewLanding } from './landing-repo'
import { getLandingScoresForCompletedFlights, resolveLandingScore } from './landing-score-resolver'

function makeLanding(flightId: number, overrides: Partial<NewLanding> = {}): NewLanding {
  return {
    flightId,
    seq: 1,
    icao: 'EGCC',
    touchdownTsUtc: '2026-09-12T12:00:00.000Z',
    verticalSpeedMs: -1.2,
    gForce: 1.1,
    pitchDeg: 4,
    bankDeg: 0,
    headingTrueDeg: 270,
    indicatedAirspeedMs: 70,
    groundSpeedMs: 68,
    windSpeedMs: 5,
    windDirectionDeg: 260,
    headwindMs: 4,
    crosswindMs: 1,
    crabDeg: 0,
    runwayIdent: '27L',
    distanceFromThresholdM: 400,
    centrelineOffsetM: 0,
    flapSetting: 3,
    touchdownSource: 'derived',
    ...overrides
  }
}

// EGLL/27L, real vendored resources/runways.csv row: length_ft=12001 (~3657.9m, >=2400m ->
// a 400m Annex-14 aiming-point distance and a 6-pair/900m touchdown zone), width_ft=164
// (~49.99m, half ~24.99m).
const EGLL_27L_LENGTH_M = 12001 * 0.3048
const EGLL_27L_AIMING_POINT_M = 400
const EGLL_27L_TOUCHDOWN_ZONE_END_M = 900
const EGLL_27L_HALF_WIDTH_M = (164 * 0.3048) / 2

function toLanding(newLanding: NewLanding): Landing {
  return { id: 1, ...newLanding }
}

describe('resolveLandingScore', () => {
  it('assembles real runway data (EGLL/27L) into the same score computeLandingScore would produce', () => {
    const landingRecord = toLanding(
      makeLanding(1, { distanceFromThresholdM: 420, centrelineOffsetM: 5, crabDeg: 2 })
    )
    const result = resolveLandingScore(landingRecord, 'EGLL', 'A320')

    const expectedInputs: LandingScoreInputs = {
      category: 'M',
      verticalSpeedMs: landingRecord.verticalSpeedMs,
      gForce: landingRecord.gForce,
      pitchDeg: landingRecord.pitchDeg,
      bankDeg: landingRecord.bankDeg,
      crabDeg: 2,
      distanceFromAimingPointM: 420 - EGLL_27L_AIMING_POINT_M,
      runwayLengthM: EGLL_27L_LENGTH_M,
      centrelineOffsetM: 5,
      centrelineToleranceM: EGLL_27L_HALF_WIDTH_M
    }
    expect(result.score).toBe(computeLandingScore(expectedInputs).overall)
    expect(result.severity).toBe('none')
  })

  it("carries each category's real ideal/tolerance for the info popover, using this runway's own real data", () => {
    const landingRecord = toLanding(makeLanding(1, { distanceFromThresholdM: 420, centrelineOffsetM: 5, crabDeg: 2 }))
    const result = resolveLandingScore(landingRecord, 'EGLL', 'A320')

    const verticalSpeed = result.categories.find((c) => c.key === 'verticalSpeed')!
    expect(verticalSpeed).toMatchObject({ ideal: 120, tolerance: 360 }) // M category

    const aimingPoint = result.categories.find((c) => c.key === 'distanceFromAimingPoint')!
    expect(aimingPoint).toMatchObject({ ideal: 0, tolerance: EGLL_27L_TOUCHDOWN_ZONE_END_M })

    const centreline = result.categories.find((c) => c.key === 'centrelineOffset')!
    expect(centreline).toMatchObject({ ideal: 0, tolerance: EGLL_27L_HALF_WIDTH_M })
  })

  it('nulls out a category\'s ideal/tolerance exactly when its score is unavailable', () => {
    const landingRecord = toLanding(
      makeLanding(1, { runwayIdent: null, distanceFromThresholdM: null, centrelineOffsetM: null, crabDeg: null })
    )
    const result = resolveLandingScore(landingRecord, 'EGLL', 'A320')

    for (const key of ['crab', 'distanceFromAimingPoint', 'centrelineOffset'] as const) {
      const category = result.categories.find((c) => c.key === key)!
      expect(category.score).toBeNull()
      expect(category.ideal).toBeNull()
      expect(category.tolerance).toBeNull()
    }
  })

  it('drops the runway-dependent inputs (still returns a score) when runwayIdent is null', () => {
    const landingRecord = toLanding(
      makeLanding(1, { runwayIdent: null, distanceFromThresholdM: null, centrelineOffsetM: null, crabDeg: null })
    )
    const result = resolveLandingScore(landingRecord, 'EGLL', 'A320')
    expect(result.score).toBeGreaterThan(0)
    expect(result.score).toBeLessThanOrEqual(100)
  })

  it('drops the runway-dependent inputs when the runway ident does not match any vendored data', () => {
    const landingRecord = toLanding(makeLanding(1, { runwayIdent: '99Z' }))
    const result = resolveLandingScore(landingRecord, 'EGLL', 'A320')
    const withoutRunway = resolveLandingScore(toLanding(makeLanding(1, { runwayIdent: null })), 'EGLL', 'A320')
    expect(result.score).toBe(withoutRunway.score)
  })

  it('falls back to the M baseline, without throwing, for a type absent from the vendored CSV', () => {
    const landingRecord = toLanding(makeLanding(1))
    expect(() => resolveLandingScore(landingRecord, 'EGLL', 'NOTATYPE')).not.toThrow()
    expect(resolveLandingScore(landingRecord, 'EGLL', 'NOTATYPE')).toEqual(
      resolveLandingScore(landingRecord, 'EGLL', null)
    )
  })

  it(
    'floors a dangerous-exceedance score at 0 for display, and maxes out every exceeding ' +
      "category's own 1-10 scaled dangerousPenalty when it's wildly past tolerance — " +
      "computeLandingScore's own overall can go negative internally (landing-scoring-v2.md, " +
      '2026-09-20), but nothing downstream of resolveLandingScore should ever see that',
    () => {
      // -1000fpm ≈ -5.08 m/s — well past every category's hard threshold, and every other
      // category similarly overshoots by several multiples of its own tolerance, so each
      // one's dangerousPenalty caps at 10 (shared/landing-score.ts's
      // DANGER_PENALTY_MAX_FRACTION), not just barely crossing into dangerous territory.
      const landingRecord = toLanding(
        makeLanding(1, {
          verticalSpeedMs: -5.08,
          gForce: 3.0,
          pitchDeg: 20,
          bankDeg: 30,
          crabDeg: 40,
          distanceFromThresholdM: 5000,
          centrelineOffsetM: 100
        })
      )
      const result = resolveLandingScore(landingRecord, 'EGLL', 'C172') // C172 -> L, lowest thresholds
      // Every one of the 7 categories is pushed past its own tolerance here, not just
      // vertical speed (2026-09-21 — see LandingScoreCategory.dangerousPenalty's own doc
      // comment for why this generalised beyond hard landings).
      const dangerousKeys: LandingScoreCategoryKey[] = [
        'verticalSpeed',
        'gForce',
        'distanceFromAimingPoint',
        'centrelineOffset',
        'pitch',
        'bank',
        'crab'
      ]
      for (const key of dangerousKeys) {
        expect(result.categories.find((c) => c.key === key)?.dangerousPenalty).toBe(10)
      }
      expect(result.score).toBe(0)
      expect(result.score).toBeGreaterThanOrEqual(0)
    }
  )

  it('reports a 0 dangerousPenalty on every category for an ordinary landing', () => {
    // makeLanding's own default pitchDeg (4) is past pitch's own tolerance (ideal -4,
    // tolerance 6 -> deviation 8) since it was tightened 2026-09-21, which would flag this
    // one category dangerous — overridden here to the exact ideal instead; this test is
    // about there being no dangerous exceedance at all, not about pitch specifically.
    const landingRecord = toLanding(makeLanding(1, { pitchDeg: -4 }))
    const result = resolveLandingScore(landingRecord, 'EGLL', 'A320')
    expect(result.categories.every((c) => c.dangerousPenalty === 0)).toBe(true)
  })

  it('derives severity from the category-scaled thresholds, not a fixed universal one', () => {
    // -450 fpm ≈ -2.286 m/s: firm for both M (300-480) and H (375-600), hard for L (225-360)
    // — a light aircraft's much lower sweet spot means the same absolute fpm reads as far
    // more violent for it than for a widebody (Landing Rate Sweet Spots table, 2026-09-13).
    const landingRecord = toLanding(makeLanding(1, { verticalSpeedMs: -2.286 }))
    expect(resolveLandingScore(landingRecord, 'EGLL', 'A320').severity).toBe('firm') // A320 -> M
    expect(resolveLandingScore(landingRecord, 'EGLL', 'A35K').severity).toBe('firm') // A35K -> H
    expect(resolveLandingScore(landingRecord, 'EGLL', 'C172').severity).toBe('hard') // C172 -> L
  })
})

describe('getLandingScoresForCompletedFlights', () => {
  let db: WingLogDb
  let aircraftId: number

  beforeEach(() => {
    const created = createDb(':memory:')
    migrate(created.db, { migrationsFolder: 'drizzle' })
    db = created.db
    aircraftId = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' }).id
  })

  it('includes only completed flights that have a landing row', () => {
    const withLanding = createFlight(db, { aircraftId, depIcao: 'EGCC', arrIcao: 'EGLL' })
    createLanding(db, makeLanding(withLanding.id))
    completeFlight(db, withLanding.id, 4000)

    const completedNoLanding = createFlight(db, { aircraftId, depIcao: 'EGLL', arrIcao: 'EGCC' })
    completeFlight(db, completedNoLanding.id, 4000)

    const stillPlanned = createFlight(db, { aircraftId, depIcao: 'EGLL', arrIcao: 'EGKK' })
    createLanding(db, makeLanding(stillPlanned.id))

    const summaries = getLandingScoresForCompletedFlights(db)
    expect(summaries).toHaveLength(1)
    expect(summaries[0].flightId).toBe(withLanding.id)
    expect(summaries[0].score).toBeGreaterThanOrEqual(0)
    expect(summaries[0].score).toBeLessThanOrEqual(100)
    expect(summaries[0].landingCount).toBe(1)
  })

  it('returns an empty array when there are no completed flights with a landing', () => {
    expect(getLandingScoresForCompletedFlights(db)).toEqual([])
  })

  it('scores a free flight with no fleet aircraft using its own sim-reported type', () => {
    const freeFlight = createFreeFlight(db, {
      aircraftId: null,
      simRegistration: 'G-TEST',
      simIcaoType: 'C172',
      depIcao: 'VHHH',
      arrIcao: 'VHHH',
      flightNumber: null,
      fuelOutKg: 500
    })
    createLanding(db, makeLanding(freeFlight.id))
    completeFlight(db, freeFlight.id, 400)

    const summaries = getLandingScoresForCompletedFlights(db)
    expect(summaries).toHaveLength(1)
    expect(summaries[0].flightId).toBe(freeFlight.id)
    expect(summaries[0].score).toBeGreaterThanOrEqual(0)
    expect(summaries[0].score).toBeLessThanOrEqual(100)
  })

  it('scores against the final touchdown and reports the real count for a flight with several', () => {
    const flight = createFlight(db, { aircraftId, depIcao: 'EGCC', arrIcao: 'EGLL' })
    // A soft first touchdown...
    createLanding(db, makeLanding(flight.id, { seq: 1, verticalSpeedMs: -0.2, gForce: 1.0 }))
    // ...then a firm final one — the score should reflect this one, not the first.
    createLanding(db, makeLanding(flight.id, { seq: 2, verticalSpeedMs: -3.5, gForce: 1.9 }))
    completeFlight(db, flight.id, 4000)

    const summaries = getLandingScoresForCompletedFlights(db)
    expect(summaries).toHaveLength(1)
    expect(summaries[0].landingCount).toBe(2)

    // Matches the landing's own icao ('EGCC', the makeLanding default — not the flight's
    // filed EGLL arrival), same as getLandingScoresForCompletedFlights itself resolves.
    const finalOnlyScore = resolveLandingScore(
      { ...makeLanding(flight.id), id: 2, seq: 2, verticalSpeedMs: -3.5, gForce: 1.9 } as Landing,
      'EGCC',
      'A320'
    ).score
    expect(summaries[0].score).toBe(finalOnlyScore)
  })
})
