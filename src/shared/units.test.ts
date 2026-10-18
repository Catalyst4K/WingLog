import { describe, expect, it } from 'vitest'
import { METRES_PER_FOOT, mToFt, msToFpm } from './units'

describe('units', () => {
  it('converts metres to feet with the exact international foot', () => {
    expect(mToFt(METRES_PER_FOOT)).toBe(1)
    expect(mToFt(11_300)).toBeCloseTo(37_073.49, 2)
  })

  it('converts a touchdown rate in m/s to feet per minute', () => {
    // -0.762 m/s is a 150 fpm touchdown, H's sweet spot (landing-score.ts).
    expect(msToFpm(-0.762)).toBeCloseTo(-150, 9)
    expect(msToFpm(0)).toBe(0)
  })
})
