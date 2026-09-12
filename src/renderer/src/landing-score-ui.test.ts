import { describe, expect, it } from 'vitest'
import { BAD_CATEGORY_THRESHOLD, categoryMaxPoints, deductionOutOf10, formatDeduction, isCategoryBad } from './landing-score-ui'

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

describe('categoryMaxPoints', () => {
  it('rescales a weight out of 100 onto a ceiling out of 10', () => {
    expect(categoryMaxPoints(100)).toBe(10)
    expect(categoryMaxPoints(25)).toBe(2.5)
    expect(categoryMaxPoints(10)).toBe(1)
  })
})

describe('deductionOutOf10', () => {
  it('is 0 for a perfect score regardless of weight', () => {
    expect(deductionOutOf10(100, 25)).toBe(0)
    expect(deductionOutOf10(100, 10)).toBe(0)
  })

  it('is -ceiling (weight/10) for a score of 0', () => {
    expect(deductionOutOf10(0, 100)).toBe(-10)
    expect(deductionOutOf10(0, 25)).toBe(-2.5)
    expect(deductionOutOf10(0, 10)).toBe(-1)
  })

  it('scales linearly in between, scaled by weight', () => {
    expect(deductionOutOf10(30, 100)).toBeCloseTo(-7, 6)
    expect(deductionOutOf10(30, 25)).toBeCloseTo(-1.75, 6)
  })

  it(
    'the same raw score deducts less for a low-weight category than a high-weight one — ' +
      "the bug Callum caught: a flat /10 scale made crab (weight 10) look as damaging as " +
      'vertical speed (weight 25) even though it can only cost 10% of the overall score',
    () => {
      const crabDeduction = deductionOutOf10(50, 10)
      const verticalSpeedDeduction = deductionOutOf10(50, 25)
      expect(Math.abs(crabDeduction)).toBeLessThan(Math.abs(verticalSpeedDeduction))
    }
  )
})

describe('formatDeduction', () => {
  it('formats a perfect score as a plain "0", not "0.0" or "-0.0"', () => {
    expect(formatDeduction(100, 100)).toBe('0')
  })

  it('formats an imperfect score to one decimal place, scaled by weight', () => {
    expect(formatDeduction(30, 100)).toBe('-7.0')
    expect(formatDeduction(30, 25)).toBe('-1.8')
  })

  it('formats a missing category as "N/A"', () => {
    expect(formatDeduction(null, 100)).toBe('N/A')
  })
})
