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
  it('describes vertical speed against the category-derived ideal/hard cutoff', () => {
    expect(describeCategoryTolerance('verticalSpeed', 130, 390, 'ft')).toBe(
      "Ideal: at or under 130 fpm for this aircraft's wake category. Score reaches 0 at 520 fpm."
    )
  })

  it('describes g-force symmetrically around its ideal', () => {
    expect(describeCategoryTolerance('gForce', 1, 1, 'ft')).toBe(
      'Ideal: 1.0 g. Score reaches 0 at 0.0 g or 2.0 g.'
    )
  })

  it('describes pitch using its own (negative) ideal', () => {
    expect(describeCategoryTolerance('pitch', -4, 8, 'ft')).toBe(
      'Ideal: -4° (nose-up flare). Score reaches 0 at -12° or 4°.'
    )
  })

  it('describes bank and crab as symmetric ± bands around 0', () => {
    expect(describeCategoryTolerance('bank', 0, 8, 'ft')).toBe('Ideal: 0° (wings level). Score reaches 0 at ±8°.')
    expect(describeCategoryTolerance('crab', 0, 9, 'ft')).toBe(
      'Ideal: 0° (crab removed by touchdown). Score reaches 0 at ±9°.'
    )
  })

  it('describes the runway-dependent categories in the chosen distance unit', () => {
    expect(describeCategoryTolerance('distanceFromAimingPoint', 0, 400, 'm')).toBe(
      "Ideal: touchdown on the aiming point. Score reaches 0 at 400 m off it — this runway's own real aiming-point distance from the threshold."
    )
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
