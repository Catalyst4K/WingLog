import { describe, expect, it } from 'vitest'
import { classifyLanding, computeLandingScore, deriveLandingThresholds, type LandingScoreInputs } from './landing-score'

// -100 fpm ≈ -0.508 m/s; -450 fpm ≈ -2.286 m/s; -1000 fpm ≈ -5.08 m/s.
function msFromFpm(fpm: number): number {
  return (fpm * 0.3048) / 60
}

describe('deriveLandingThresholds', () => {
  it('derives L (light GA): firm 375, hard 600', () => {
    expect(deriveLandingThresholds('L')).toEqual({ firmFpm: 375, hardFpm: 600 })
  })

  it('derives M (narrowbody): firm 325, hard 520', () => {
    expect(deriveLandingThresholds('M')).toEqual({ firmFpm: 325, hardFpm: 520 })
  })

  it('derives H (widebody): firm 275, hard 440', () => {
    expect(deriveLandingThresholds('H')).toEqual({ firmFpm: 275, hardFpm: 440 })
  })

  it('derives J (super) the same as H — too sparse a category to differ', () => {
    expect(deriveLandingThresholds('J')).toEqual(deriveLandingThresholds('H'))
  })

  it('falls back to M for an unrecognised type', () => {
    expect(deriveLandingThresholds(null)).toEqual(deriveLandingThresholds('M'))
  })
})

describe('classifyLanding', () => {
  const THRESHOLDS = { firmFpm: 480, hardFpm: 600 }

  it('is "none" for a gentle landing, well under the firm threshold', () => {
    expect(classifyLanding(-1, THRESHOLDS)).toBe('none')
  })

  it('is "firm" exactly at the firm threshold', () => {
    expect(classifyLanding(msFromFpm(-480), THRESHOLDS)).toBe('firm')
  })

  it('is "hard" exactly at the hard threshold', () => {
    expect(classifyLanding(msFromFpm(-600), THRESHOLDS)).toBe('hard')
  })

  it('classifies on magnitude regardless of sign', () => {
    expect(classifyLanding(3.5, THRESHOLDS)).toBe('hard')
  })

  it('respects the thresholds passed in rather than a hardcoded constant', () => {
    expect(classifyLanding(-3.5, { firmFpm: 1000, hardFpm: 1500 })).toBe('none')
  })
})

// A perfect landing on every input, category M: 130fpm ideal, 0 deviation everywhere.
const PERFECT_M: LandingScoreInputs = {
  category: 'M',
  verticalSpeedMs: msFromFpm(-100), // below ideal — one-sided, no penalty for being gentler
  gForce: 1.0,
  pitchDeg: -4, // ideal flare — negative is nose-up in MSFS's PLANE PITCH DEGREES
  bankDeg: 0,
  crabDeg: 0,
  distanceFromAimingPointM: 0,
  aimingPointToleranceM: 300,
  centrelineOffsetM: 0,
  centrelineToleranceM: 25
}

describe('computeLandingScore', () => {
  it('scores a perfect landing at 100 overall and on every input', () => {
    const result = computeLandingScore(PERFECT_M)
    expect(result.overall).toBe(100)
    expect(result.inputs).toEqual({
      verticalSpeed: 100,
      gForce: 100,
      distanceFromAimingPoint: 100,
      centrelineOffset: 100,
      pitch: 100,
      bank: 100,
      crab: 100
    })
  })

  it('floors a genuinely dangerous landing at 0, never negative, across categories', () => {
    const dangerous: LandingScoreInputs = {
      category: 'M',
      verticalSpeedMs: msFromFpm(-1000),
      gForce: 3.0,
      pitchDeg: 20,
      bankDeg: 30,
      crabDeg: 40,
      distanceFromAimingPointM: 1000,
      aimingPointToleranceM: 300,
      centrelineOffsetM: 100,
      centrelineToleranceM: 25
    }
    const result = computeLandingScore(dangerous)
    expect(result.overall).toBe(0)
    expect(Object.values(result.inputs)).toEqual([0, 0, 0, 0, 0, 0, 0])

    // Same absolute vertical speed scores worse for a lighter category (lower ideal/hard
    // baseline) — proves the score is genuinely category-sensitive, not just VS-in-fpm.
    const lightDangerous = computeLandingScore({ ...dangerous, category: 'L' })
    expect(lightDangerous.inputs.verticalSpeed).toBe(0)
  })

  it('is category-sensitive: the same vertical speed scores differently for L vs H', () => {
    // -450 fpm: firm-band for M (325-520) and H (275-440, actually past hard), gentle for L (ideal 150, hard 600).
    const base = { ...PERFECT_M, verticalSpeedMs: msFromFpm(-450) }
    const light = computeLandingScore({ ...base, category: 'L' }).inputs.verticalSpeed
    const heavy = computeLandingScore({ ...base, category: 'H' }).inputs.verticalSpeed
    expect(light).toBeGreaterThan(heavy)
  })

  it('scores a firm-band vertical speed as a real mid-range value, not a cliff', () => {
    // M: ideal 130, hard 520, tolerance 390. Excess = 450-130=320. Score = round(100*(1-320/390)).
    const result = computeLandingScore({ ...PERFECT_M, verticalSpeedMs: msFromFpm(-450) })
    expect(result.inputs.verticalSpeed).toBe(18)
    expect(result.overall).toBeGreaterThan(0)
    expect(result.overall).toBeLessThan(100)
  })

  it(
    'flags a 5° crab as a real drag on the score, not a shrug — tightened 2026-09-12 after ' +
      'Callum reported a real 5.7° crab landing not reading as bad',
    () => {
      // Tolerance 9°: score(5) = round(100*(1-5/9)) = 44 — below LandingScoreBreakdownDialog's
      // BAD_CATEGORY_THRESHOLD (50), landing-score-ui.ts.
      const result = computeLandingScore({ ...PERFECT_M, crabDeg: 5 })
      expect(result.inputs.crab).toBe(44)
      expect(result.inputs.crab).toBeLessThan(50)
    }
  )

  it('still scores a couple of degrees of crab gently, not as a cliff', () => {
    // score(2) = round(100*(1-2/9)) = 78 — comfortably above the bad threshold.
    const result = computeLandingScore({ ...PERFECT_M, crabDeg: 2 })
    expect(result.inputs.crab).toBe(78)
  })

  it('renormalizes over the available weight when there is no runway match', () => {
    const noRunway: LandingScoreInputs = {
      ...PERFECT_M,
      crabDeg: null,
      distanceFromAimingPointM: null,
      aimingPointToleranceM: null,
      centrelineOffsetM: null,
      centrelineToleranceM: null
    }
    const result = computeLandingScore(noRunway)
    expect(result.overall).toBe(100)
    expect(result.inputs.crab).toBeNull()
    expect(result.inputs.distanceFromAimingPoint).toBeNull()
    expect(result.inputs.centrelineOffset).toBeNull()
  })

  it('falls back to the M baseline for an unrecognised (null) category', () => {
    const withNullCategory = computeLandingScore({ ...PERFECT_M, category: null })
    const withM = computeLandingScore({ ...PERFECT_M, category: 'M' })
    expect(withNullCategory).toEqual(withM)
  })
})
