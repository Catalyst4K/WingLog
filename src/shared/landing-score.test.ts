import { describe, expect, it } from 'vitest'
import { classifyLanding, computeLandingScore, deriveLandingThresholds, type LandingScoreInputs } from './landing-score'

// -100 fpm ≈ -0.508 m/s; -450 fpm ≈ -2.286 m/s; -1000 fpm ≈ -5.08 m/s.
function msFromFpm(fpm: number): number {
  return (fpm * 0.3048) / 60
}

describe('deriveLandingThresholds', () => {
  // Landing Rate Sweet Spots by Weight Category (fpm) table, 2026-09-13 — sweet spot
  // *2.5 / *4 respectively, same multiplier mechanism as before, just fed the new numbers.
  it('derives L (light GA): sweet spot 90 -> firm 225, hard 360', () => {
    expect(deriveLandingThresholds('L')).toEqual({ firmFpm: 225, hardFpm: 360 })
  })

  it('derives M (narrowbody): sweet spot 120 -> firm 300, hard 480', () => {
    expect(deriveLandingThresholds('M')).toEqual({ firmFpm: 300, hardFpm: 480 })
  })

  it('derives H (widebody): sweet spot 150 -> firm 375, hard 600', () => {
    expect(deriveLandingThresholds('H')).toEqual({ firmFpm: 375, hardFpm: 600 })
  })

  it('derives J (super) higher than H — A380 nudged to a 160 sweet spot for its longer-travel gear', () => {
    expect(deriveLandingThresholds('J')).toEqual({ firmFpm: 400, hardFpm: 640 })
    expect(deriveLandingThresholds('J')).not.toEqual(deriveLandingThresholds('H'))
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

// A perfect landing on every input, category M: 120fpm sweet spot, 0 deviation everywhere.
const PERFECT_M: LandingScoreInputs = {
  category: 'M',
  verticalSpeedMs: msFromFpm(-120), // M's real sweet spot — two-sided now, so this is where it peaks
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
    // -450 fpm: past L's hard threshold (sweet 90, hard 360) — clamped to 0. Still firm-band
    // for H (sweet 150, hard 600, tolerance 450) — a real, non-zero mid-range value. A light
    // aircraft's much lower baseline means the same absolute fpm reads as far more violent
    // for it than for a widebody, the reverse of the old flat-ideal design.
    const base = { ...PERFECT_M, verticalSpeedMs: msFromFpm(-450) }
    const light = computeLandingScore({ ...base, category: 'L' }).inputs.verticalSpeed
    const heavy = computeLandingScore({ ...base, category: 'H' }).inputs.verticalSpeed
    expect(heavy).toBeGreaterThan(light)
  })

  it('scores a firm-band vertical speed as a real mid-range value, not a cliff', () => {
    // M: sweet 120, hard 480, toleranceAbove 360. Excess = 450-120=330. Score = round(100*(1-330/360)).
    const result = computeLandingScore({ ...PERFECT_M, verticalSpeedMs: msFromFpm(-450) })
    expect(result.inputs.verticalSpeed).toBe(8)
    expect(result.overall).toBeGreaterThan(0)
    expect(result.overall).toBeLessThan(100)
  })

  describe('vertical speed: symmetric decay around the real sweet spot (Landing Rate Sweet Spots table, 2026-09-13)', () => {
    it('peaks at exactly the sweet spot, not just anywhere under the old flat ideal', () => {
      // L: sweet spot 90fpm.
      const result = computeLandingScore({ ...PERFECT_M, category: 'L', verticalSpeedMs: msFromFpm(-90) })
      expect(result.inputs.verticalSpeed).toBe(100)
    })

    it(
      'only barely penalizes a touchdown gentler than the sweet spot — a first cut zeroed it ' +
        "out right at the range's own floor, which Callum flagged as too harsh (2026-09-13): a " +
        'landing a little under the labelled range is still a fine, gentle one in the real world',
      () => {
        // L: sweet 90, tolerance 270 (same distance as the firm side's hard threshold, 360).
        // 60fpm (the range's own labelled floor) used to score exactly 0 — now still 89.
        const result = computeLandingScore({ ...PERFECT_M, category: 'L', verticalSpeedMs: msFromFpm(-60) })
        expect(result.inputs.verticalSpeed).toBe(89)
      }
    )

    it('stays high even for an unrealistically soft touchdown, since the soft side never truly fails', () => {
      // L: sweet 90, tolerance 270. Deviation at 0fpm = -90. Score = round(100*(1-90/270)) = 67.
      // The formula's own "zero" point for this side (90-270=-180) is negative — physically
      // unreachable, since fpm can't go below 0 — so a real landing never actually bottoms out
      // for being too soft, only for being too firm.
      const result = computeLandingScore({ ...PERFECT_M, category: 'L', verticalSpeedMs: 0 })
      expect(result.inputs.verticalSpeed).toBe(67)
    })

    it('decays gently for a landing only a little softer than the sweet spot, not a cliff', () => {
      // L: sweet 90, tolerance 270. Deviation = 75-90=-15. Score = round(100*(1-15/270)) = 94.
      const result = computeLandingScore({ ...PERFECT_M, category: 'L', verticalSpeedMs: msFromFpm(-75) })
      expect(result.inputs.verticalSpeed).toBe(94)
    })

    it("uses J's own nudged 160fpm sweet spot, distinct from H's 150", () => {
      const atJSweetSpot = computeLandingScore({ ...PERFECT_M, category: 'J', verticalSpeedMs: msFromFpm(-160) })
      const atHSweetSpotButJCategory = computeLandingScore({
        ...PERFECT_M,
        category: 'J',
        verticalSpeedMs: msFromFpm(-150)
      })
      expect(atJSweetSpot.inputs.verticalSpeed).toBe(100)
      expect(atHSweetSpotButJCategory.inputs.verticalSpeed).toBeLessThan(100)
    })
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

  describe('details', () => {
    it("reports each fixed-constant category's real ideal/tolerance, category-scaled and symmetric for vertical speed", () => {
      const { details } = computeLandingScore(PERFECT_M)
      // M: sweet 120, hard 480 -> tolerance 360, same on both sides.
      expect(details.verticalSpeed).toEqual({ ideal: 120, tolerance: 360 })
      expect(details.gForce).toEqual({ ideal: 1, tolerance: 1 })
      expect(details.pitch).toEqual({ ideal: -4, tolerance: 8 })
      expect(details.bank).toEqual({ ideal: 0, tolerance: 8 })
      expect(details.crab).toEqual({ ideal: 0, tolerance: 9 })
    })

    it("reports the runway-dependent categories' real per-flight tolerance (this runway's own data)", () => {
      const { details } = computeLandingScore(PERFECT_M)
      expect(details.distanceFromAimingPoint).toEqual({ ideal: 0, tolerance: 300 })
      expect(details.centrelineOffset).toEqual({ ideal: 0, tolerance: 25 })
    })

    it('scales vertical speed ideal/tolerance to a different wake category', () => {
      const { details } = computeLandingScore({ ...PERFECT_M, category: 'H' })
      // H: sweet 150, hard 600 -> tolerance 450.
      expect(details.verticalSpeed).toEqual({ ideal: 150, tolerance: 450 })
    })

    it('is null exactly for the categories with no runway match, even though crab keeps its constant', () => {
      const noRunway: LandingScoreInputs = {
        ...PERFECT_M,
        crabDeg: null,
        distanceFromAimingPointM: null,
        aimingPointToleranceM: null,
        centrelineOffsetM: null,
        centrelineToleranceM: null
      }
      const { details } = computeLandingScore(noRunway)
      expect(details.distanceFromAimingPoint).toBeNull()
      expect(details.centrelineOffset).toBeNull()
      // crab's ideal/tolerance are fixed constants, not runway data — only null when crabDeg
      // itself is unavailable, which it is here too, so this asserts the *reason* rather
      // than assuming it follows the runway-dependent pair automatically.
      expect(details.crab).toBeNull()
    })
  })
})
