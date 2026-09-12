import { describe, expect, it } from 'vitest'
import { BAD_CATEGORY_THRESHOLD, deductionOutOf10, formatDeduction, isCategoryBad } from './landing-score-ui'

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

describe('deductionOutOf10', () => {
  it('is 0 for a perfect score', () => {
    expect(deductionOutOf10(100)).toBe(0)
  })

  it('is -10 for a score of 0', () => {
    expect(deductionOutOf10(0)).toBe(-10)
  })

  it('scales linearly in between', () => {
    expect(deductionOutOf10(30)).toBeCloseTo(-7, 6)
    expect(deductionOutOf10(87)).toBeCloseTo(-1.3, 6)
  })
})

describe('formatDeduction', () => {
  it('formats a perfect score as a plain "0", not "0.0" or "-0.0"', () => {
    expect(formatDeduction(100)).toBe('0')
  })

  it('formats an imperfect score to one decimal place', () => {
    expect(formatDeduction(30)).toBe('-7.0')
  })

  it('formats a missing category as "N/A"', () => {
    expect(formatDeduction(null)).toBe('N/A')
  })
})
