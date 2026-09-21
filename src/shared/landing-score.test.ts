import { describe, expect, it } from 'vitest'
import {
  classifyLanding,
  computeLandingScore,
  deriveLandingThresholds,
  touchdownZonePairCountForLengthM,
  type LandingScoreInputs
} from './landing-score'

// -100 fpm ≈ -0.508 m/s; -450 fpm ≈ -2.286 m/s; -1000 fpm ≈ -5.08 m/s.
function msFromFpm(fpm: number): number {
  return (fpm * 0.3048) / 60
}

// Moved from src/renderer/src/touchdown-diagram.test.ts, 2026-09-13, alongside the function
// itself (see touchdown-diagram.ts's own doc comment for why it moved here).
describe('touchdownZonePairCountForLengthM', () => {
  it.each([
    [500, 1],
    [899, 1],
    [900, 2],
    [1199, 2],
    [1200, 3],
    [1499, 3],
    [1500, 4],
    [2399, 4],
    [2400, 6],
    [4000, 6]
  ])('maps a %dm runway to %d touchdown-zone pairs', (lengthM, expected) => {
    expect(touchdownZonePairCountForLengthM(lengthM)).toBe(expected)
  })
})

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
// runwayLengthM 3000 -> a long (>=2400m), 6-pair touchdown zone — a typical major-airport
// runway, used as the baseline for tests that aren't specifically about zone length.
const PERFECT_M: LandingScoreInputs = {
  category: 'M',
  verticalSpeedMs: msFromFpm(-120), // M's real sweet spot — two-sided now, so this is where it peaks
  gForce: 1.0,
  pitchDeg: -4, // ideal flare — negative is nose-up in MSFS's PLANE PITCH DEGREES
  bankDeg: 0,
  crabDeg: 0,
  distanceFromAimingPointM: 0,
  runwayLengthM: 3000,
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

  it(
    'floors every category at 0 individually, but lets overall go negative once the ' +
      'dangerous-exceedance deduction applies (landing-scoring-v2.md, 2026-09-20 — v1 had ' +
      'no such deduction and floored overall at 0 too; v2 deliberately reopened that)',
    () => {
      const dangerous: LandingScoreInputs = {
        category: 'M',
        verticalSpeedMs: msFromFpm(-1000),
        gForce: 3.0,
        pitchDeg: 20,
        bankDeg: 30,
        crabDeg: 40,
        distanceFromAimingPointM: 1000,
        runwayLengthM: 3000, // 6-pair zone, 900m end -> 1000m offset is well past it
        centrelineOffsetM: 100,
        centrelineToleranceM: 25
      }
      const result = computeLandingScore(dangerous)
      // Every category is individually clamped to 0 -> weighted average is 0. All 7 also
      // exceed their own tolerance (2026-09-21 — generalised beyond vertical-speed-only), so
      // 7 * DANGEROUS_EXCEEDANCE_DEDUCTION (20) -> -140. Flooring THIS raw value at 0 for
      // display is the caller's job (landing-score-resolver.ts), not computeLandingScore's.
      expect(result.overall).toBe(-140)
      expect(result.dangerousCategories.sort()).toEqual(
        ['verticalSpeed', 'gForce', 'distanceFromAimingPoint', 'centrelineOffset', 'pitch', 'bank', 'crab'].sort()
      )
      expect(Object.values(result.inputs)).toEqual([0, 0, 0, 0, 0, 0, 0])

      // Same absolute vertical speed scores worse for a lighter category (lower ideal/hard
      // baseline) — proves the score is genuinely category-sensitive, not just VS-in-fpm.
      const lightDangerous = computeLandingScore({ ...dangerous, category: 'L' })
      expect(lightDangerous.inputs.verticalSpeed).toBe(0)
    }
  )

  it('is not dangerous, and applies no deduction, for a landing that never reaches the hard threshold', () => {
    const result = computeLandingScore(PERFECT_M)
    expect(result.dangerousCategories).toEqual([])
    expect(result.overall).toBe(100)
  })

  it('lists only the categories that actually exceeded, and stacks their deductions — real ' +
    'VHHH free-flight landing, 2026-09-21: a 7.19° crab (tolerance 6.5°) and a touchdown ' +
    "~965m past the runway's last real touchdown-zone pair, together, with an otherwise " +
    "soft, well-centred touchdown that shouldn't itself be flagged", () => {
    const result = computeLandingScore({
      ...PERFECT_M,
      crabDeg: 7.19,
      runwayLengthM: 3800, // long enough for 6 pairs (900m zone)
      distanceFromAimingPointM: 965
    })
    expect(result.dangerousCategories.sort()).toEqual(['crab', 'distanceFromAimingPoint'].sort())
    // Weighted average: crab (weight 10) and distanceFromAimingPoint (weight 20) both 0;
    // everything else stays perfect (100). (0*30 + 100*70) / 100 = 70. Minus 2 *
    // DANGEROUS_EXCEEDANCE_DEDUCTION (20) = 30.
    expect(result.overall).toBe(30)
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
    // M: sweet 120, hard 480, tolerance 360. Excess = 450-120=330.
    // Score = round(100*(1-(330/360)^1.5)) = round(100*(1-0.8777)) = 12.
    const result = computeLandingScore({ ...PERFECT_M, verticalSpeedMs: msFromFpm(-450) })
    expect(result.inputs.verticalSpeed).toBe(12)
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
        'landing a little under the labelled range is still a fine, gentle one in the real world ' +
        '— even gentler under the v2 tapered curve (landing-scoring-v2.md, 2026-09-20), which is ' +
        'flat by design near ideal',
      () => {
        // L: sweet 90, tolerance 270 (same distance as the firm side's hard threshold, 360).
        // 60fpm (the range's own labelled floor): deviation 30.
        // Score = round(100*(1-(30/270)^1.5)) = round(100*(1-0.037)) = 96.
        const result = computeLandingScore({ ...PERFECT_M, category: 'L', verticalSpeedMs: msFromFpm(-60) })
        expect(result.inputs.verticalSpeed).toBe(96)
      }
    )

    it('stays high even for an unrealistically soft touchdown, since the soft side never truly fails', () => {
      // L: sweet 90, tolerance 270. Deviation at 0fpm = 90.
      // Score = round(100*(1-(90/270)^1.5)) = round(100*(1-0.1925)) = 81.
      // The formula's own "zero" point for this side (90-270=-180) is negative — physically
      // unreachable, since fpm can't go below 0 — so a real landing never actually bottoms out
      // for being too soft, only for being too firm.
      const result = computeLandingScore({ ...PERFECT_M, category: 'L', verticalSpeedMs: 0 })
      expect(result.inputs.verticalSpeed).toBe(81)
    })

    it('decays gently for a landing noticeably softer than the sweet spot, not a cliff', () => {
      // L: sweet 90, tolerance 270. A deviation as small as 15fpm now rounds back to 100 under
      // the v2 tapered curve — deliberately flat near ideal (landing-scoring-v2.md,
      // 2026-09-20) — so this uses a bigger, still-realistic gap to show real, non-cliff decay.
      // Deviation = 90-45=45. Score = round(100*(1-(45/270)^1.5)) = round(100*(1-0.068)) = 93.
      const result = computeLandingScore({ ...PERFECT_M, category: 'L', verticalSpeedMs: msFromFpm(-45) })
      expect(result.inputs.verticalSpeed).toBe(93)
    })

    it("uses J's own nudged 160fpm sweet spot, distinct from H's 150", () => {
      const atJSweetSpot = computeLandingScore({ ...PERFECT_M, category: 'J', verticalSpeedMs: msFromFpm(-160) })
      expect(atJSweetSpot.inputs.verticalSpeed).toBe(100)
      expect(atJSweetSpot.details.verticalSpeed.ideal).toBe(160)
      const atHSweetSpotButJCategory = computeLandingScore({ ...PERFECT_M, category: 'H', verticalSpeedMs: msFromFpm(-150) })
      // H's own ideal (150) is J's, so scoring J against that exact same category confirms
      // the two bands are genuinely distinct, not the same table under two names.
      expect(atHSweetSpotButJCategory.details.verticalSpeed.ideal).toBe(150)

      // A deviation small enough to matter needs to be sizeable given the tapered curve's
      // own flatness near ideal (10fpm off J's sweet spot still rounds to 100) — 60fpm off
      // clearly shows J's own tolerance (480) still applies, not H's narrower one (450).
      const wellOffJSweetSpot = computeLandingScore({ ...PERFECT_M, category: 'J', verticalSpeedMs: msFromFpm(-100) })
      expect(wellOffJSweetSpot.inputs.verticalSpeed).toBeLessThan(100)
    })
  })

  describe('distance from aiming point: stepped touchdown-zone scoring (Callum\'s own spec, 2026-09-13)', () => {
    it('is perfect dead on the aiming point', () => {
      const result = computeLandingScore({ ...PERFECT_M, distanceFromAimingPointM: 0 })
      expect(result.inputs.distanceFromAimingPoint).toBe(100)
    })

    it('stays perfect anywhere within the first real touchdown-zone pair (150m)', () => {
      const result = computeLandingScore({ ...PERFECT_M, distanceFromAimingPointM: 140 })
      expect(result.inputs.distanceFromAimingPoint).toBe(100)
    })

    it('is 2 points down (out of 10) in the second pair, either direction', () => {
      const long = computeLandingScore({ ...PERFECT_M, distanceFromAimingPointM: 200 })
      const short = computeLandingScore({ ...PERFECT_M, distanceFromAimingPointM: -200 })
      expect(long.inputs.distanceFromAimingPoint).toBe(80)
      expect(short.inputs.distanceFromAimingPoint).toBe(80)
    })

    it('is 4 points down in the third pair — a step, not a smooth taper', () => {
      const result = computeLandingScore({ ...PERFECT_M, distanceFromAimingPointM: 320 })
      expect(result.inputs.distanceFromAimingPoint).toBe(60)
    })

    it(
      "reaches 0 one full pair before a 6-pair runway's own outer edge — -20 per pair times " +
        '6 pairs already lands on exactly 0, so the last pair (750-900m) and "past the zone" ' +
        'read the same',
      () => {
        const fifthPair = computeLandingScore({ ...PERFECT_M, distanceFromAimingPointM: 700 }) // 600-750m
        const sixthPair = computeLandingScore({ ...PERFECT_M, distanceFromAimingPointM: 800 }) // 750-900m
        const pastTheZone = computeLandingScore({ ...PERFECT_M, distanceFromAimingPointM: 950 })
        expect(fifthPair.inputs.distanceFromAimingPoint).toBe(20)
        expect(sixthPair.inputs.distanceFromAimingPoint).toBe(0)
        expect(pastTheZone.inputs.distanceFromAimingPoint).toBe(0)
      }
    )

    it('cliffs to 0 right past a short runway\'s own real touchdown zone, not a further gentle taper', () => {
      // 700m runway -> 1 pair (touchdownZonePairCountForLengthM), zone ends at 150m.
      const withinZone = computeLandingScore({ ...PERFECT_M, runwayLengthM: 700, distanceFromAimingPointM: 149 })
      const pastZone = computeLandingScore({ ...PERFECT_M, runwayLengthM: 700, distanceFromAimingPointM: 151 })
      expect(withinZone.inputs.distanceFromAimingPoint).toBe(100)
      expect(pastZone.inputs.distanceFromAimingPoint).toBe(0)
    })

    it('gives a longer runway a more forgiving graduated scale than a short one, same offset', () => {
      // 500m past the aiming point: still mid-scale on a long runway (6 pairs, ends at
      // 900m) but already off the zone entirely on a short one (1 pair, ends at 150m).
      const longRunway = computeLandingScore({ ...PERFECT_M, runwayLengthM: 3000, distanceFromAimingPointM: 500 })
      const shortRunway = computeLandingScore({ ...PERFECT_M, runwayLengthM: 700, distanceFromAimingPointM: 500 })
      expect(longRunway.inputs.distanceFromAimingPoint).toBeGreaterThan(0)
      expect(shortRunway.inputs.distanceFromAimingPoint).toBe(0)
    })
  })

  it(
    'flags a 5° crab as a real drag on the score, not a shrug — tightened 2026-09-12 after ' +
      "Callum reported a real 5.7° crab landing not reading as bad, and retightened again " +
      '2026-09-20 when switching to the tapered (quadratic) curve pushed it back above the ' +
      'bad threshold (landing-scoring-v2.md — see CRAB_TOLERANCE_DEG\'s own doc comment)',
    () => {
      // Tolerance 6.5°: score(5) = round(100*(1-(5/6.5)^1.5)) = 33 — below
      // LandingScoreBreakdownDialog's BAD_CATEGORY_THRESHOLD (50), landing-score-ui.ts.
      const result = computeLandingScore({ ...PERFECT_M, crabDeg: 5 })
      expect(result.inputs.crab).toBe(33)
      expect(result.inputs.crab).toBeLessThan(50)
    }
  )

  it('still scores a couple of degrees of crab gently, not as a cliff', () => {
    // score(2) = round(100*(1-(2/6.5)^1.5)) = 83 — comfortably above the bad threshold.
    const result = computeLandingScore({ ...PERFECT_M, crabDeg: 2 })
    expect(result.inputs.crab).toBe(83)
  })

  it(
    "doesn't read a deviation halfway through tolerance as still-mostly-good — real BAW32 " +
      'flight, 2026-09-20: a -359fpm touchdown (H category) and a 3.2° crab, both roughly ' +
      "halfway through their own tolerance, each scored ~78/~76 under the tapered curve's " +
      "first cut (a full square, fraction^2) — Callum's own read was that halfway to the " +
      "limit should feel closer to half credit, not still comfortably good. Retuned the " +
      "same day from fraction^2 to fraction^1.5 (taperedScore's own history) to bring the " +
      'middle of the range down without re-flattening the near-ideal end a straight line would.',
    () => {
      // H: sweet 150, hard 600, tolerance 450. |−359| − 150 = 209. fraction = 209/450 = 0.4644.
      // score = round(100*(1-0.4644^1.5)) = 68.
      const verticalSpeed = computeLandingScore({ ...PERFECT_M, category: 'H', verticalSpeedMs: msFromFpm(-359) })
      expect(verticalSpeed.inputs.verticalSpeed).toBe(68)

      // Crab tolerance 6.5°. fraction = 3.2/6.5 = 0.4923. score = round(100*(1-0.4923^1.5)) = 65.
      const crab = computeLandingScore({ ...PERFECT_M, crabDeg: 3.2 })
      expect(crab.inputs.crab).toBe(65)
    }
  )

  it('renormalizes over the available weight when there is no runway match', () => {
    const noRunway: LandingScoreInputs = {
      ...PERFECT_M,
      crabDeg: null,
      distanceFromAimingPointM: null,
      runwayLengthM: null,
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
      expect(details.crab).toEqual({ ideal: 0, tolerance: 6.5 })
    })

    it("reports the runway-dependent categories' real per-flight tolerance (this runway's own data)", () => {
      const { details } = computeLandingScore(PERFECT_M)
      // runwayLengthM 3000 -> 6 pairs * 150m.
      expect(details.distanceFromAimingPoint).toEqual({ ideal: 0, tolerance: 900 })
      expect(details.centrelineOffset).toEqual({ ideal: 0, tolerance: 25 })
    })

    it("scales distance-from-aiming-point tolerance to a shorter runway's smaller real touchdown zone", () => {
      const { details } = computeLandingScore({ ...PERFECT_M, runwayLengthM: 700 })
      // 700m -> 1 pair * 150m.
      expect(details.distanceFromAimingPoint).toEqual({ ideal: 0, tolerance: 150 })
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
        runwayLengthM: null,
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
