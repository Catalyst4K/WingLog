import { describe, expect, it } from 'vitest'
import {
  BAD_CATEGORY_THRESHOLD,
  categoryScoreOutOf10,
  describeCategoryTolerance,
  formatCategoryScore,
  isCategoryBad
} from './landing-score-ui'

describe('isCategoryBad', () => {
  it('is false for a perfect score', () => {
    expect(isCategoryBad(100)).toBe(false)
  })

  it('is false exactly at the threshold', () => {
    expect(isCategoryBad(BAD_CATEGORY_THRESHOLD)).toBe(false)
  })

  it('is true just under the threshold', () => {
    expect(isCategoryBad(BAD_CATEGORY_THRESHOLD - 1)).toBe(true)
  })

  it('is false for a null (unavailable) category, not a fabricated verdict', () => {
    expect(isCategoryBad(null)).toBe(false)
  })
})

describe('categoryScoreOutOf10', () => {
  it('rescales a 0-100 score onto a plain 0-10 rating', () => {
    expect(categoryScoreOutOf10(100)).toBe(10)
    expect(categoryScoreOutOf10(0)).toBe(0)
    expect(categoryScoreOutOf10(89)).toBe(9) // rounds, doesn't floor
    expect(categoryScoreOutOf10(84)).toBe(8)
  })
})

describe('formatCategoryScore', () => {
  it('formats a category score as a plain integer out of 10', () => {
    expect(formatCategoryScore(100)).toBe('10')
    expect(formatCategoryScore(89)).toBe('9')
    expect(formatCategoryScore(0)).toBe('0')
  })

  it('formats a missing category as "N/A"', () => {
    expect(formatCategoryScore(null)).toBe('N/A')
  })
})

describe('describeCategoryTolerance', () => {
  it('describes vertical speed against its real sweet spot, not penalizing a soft landing hard', () => {
    // M: sweet 120, tolerance 360 -> firm-side zero at 480. Soft-side zero (120-360=-240) is
    // never reachable (fpm can't go negative), so the copy doesn't mention it at all.
    expect(describeCategoryTolerance('verticalSpeed', 120, 360, 'ft')).toBe(
      "Sweet spot: 120 fpm for this aircraft's wake category. A softer touchdown is barely penalized — score only reaches 0 if too firm, at 480 fpm."
    )
  })

  it('describes g-force symmetrically around its ideal', () => {
    expect(describeCategoryTolerance('gForce', 1, 1, 'ft')).toBe(
      'Ideal: 1.0 g. Score reaches 0 at 0.0 g or 2.0 g.'
    )
  })

  it(
    'flips pitch to a conventional positive nose-up reading — the internal `ideal` is ' +
      'SimVar-signed (negative = nose-up), but a pilot reads a flare as a positive number ' +
      '(Callum, 2026-09-13: "I think you forgot to flip the value")',
    () => {
      expect(describeCategoryTolerance('pitch', -4, 8, 'ft')).toBe(
        'Ideal: 4° nose-up. Score reaches 0 at -4° or 12°.'
      )
    }
  )

  it('describes bank and crab as symmetric ± bands around 0', () => {
    expect(describeCategoryTolerance('bank', 0, 8, 'ft')).toBe('Ideal: 0° (wings level). Score reaches 0 at ±8°.')
    expect(describeCategoryTolerance('crab', 0, 9, 'ft')).toBe(
      'Ideal: 0° (crab removed by touchdown). Score reaches 0 at ±9°.'
    )
  })

  it('describes distance-from-aiming-point as three stepped bands, not a single reaches-0 number', () => {
    // tolerance 900 -> a long (6-pair) runway's real touchdown zone; thirds land on clean
    // round numbers (300/600/900) for a readable assertion.
    expect(describeCategoryTolerance('distanceFromAimingPoint', 0, 900, 'm')).toBe(
      'Ideal: touchdown on the aiming point, either direction. Within 300 m: perfect. ' +
        'Out to 600 m: 2 points off (of 10). Out to 900 m: 4 points off. ' +
        'Beyond that: 0 — off the graded touchdown zone entirely.'
    )
  })

  it('describes centreline offset in the chosen distance unit', () => {
    expect(describeCategoryTolerance('centrelineOffset', 0, 12.5, 'ft')).toBe(
      'Ideal: on the centreline. Score reaches 0 at 41 ft off it — half this runway\'s real width.'
    )
  })

  it('reports unavailable rather than fabricating a value when there is no runway match', () => {
    expect(describeCategoryTolerance('crab', null, null, 'ft')).toBe(
      'Not available for this landing — no matched runway.'
    )
  })
})
