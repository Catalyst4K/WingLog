import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { Landing } from '@shared/ipc'
import { computeLandingScore, type LandingScoreInputs } from '@shared/landing-score'
import { createAircraft } from './aircraft-repo'
import { createDb, type WingLogDb } from './client'
import { completeFlight, createFlight } from './flight-repo'
import { createLanding, type NewLanding } from './landing-repo'
import { getLandingScoresForCompletedFlights, resolveLandingScore } from './landing-score-resolver'

function makeLanding(flightId: number, overrides: Partial<NewLanding> = {}): NewLanding {
  return {
    flightId,
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

// EGLL/27L, real vendored resources/runways.csv row: length_ft=12001 (>=2400m -> a 400m
// Annex-14 aiming-point distance), width_ft=164 (~49.99m, half ~24.99m).
const EGLL_27L_AIMING_POINT_M = 400
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
      aimingPointToleranceM: EGLL_27L_AIMING_POINT_M,
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
    expect(verticalSpeed).toMatchObject({ ideal: 130, tolerance: 390 }) // M category

    const aimingPoint = result.categories.find((c) => c.key === 'distanceFromAimingPoint')!
    expect(aimingPoint).toMatchObject({ ideal: 0, tolerance: EGLL_27L_AIMING_POINT_M })

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

  it('derives severity from the category-scaled thresholds, not a fixed universal one', () => {
    // -450 fpm ≈ -2.286 m/s: firm for both M (325-520) and L (375-600), hard for H (275-440).
    const landingRecord = toLanding(makeLanding(1, { verticalSpeedMs: -2.286 }))
    expect(resolveLandingScore(landingRecord, 'EGLL', 'A320').severity).toBe('firm') // A320 -> M
    expect(resolveLandingScore(landingRecord, 'EGLL', 'A35K').severity).toBe('hard') // A35K -> H
    expect(resolveLandingScore(landingRecord, 'EGLL', 'C172').severity).toBe('firm') // C172 -> L
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
  })

  it('returns an empty array when there are no completed flights with a landing', () => {
    expect(getLandingScoresForCompletedFlights(db)).toEqual([])
  })
})
