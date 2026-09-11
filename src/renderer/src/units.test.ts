import { describe, expect, it } from 'vitest'
import {
  formatAltitude,
  formatMinutes,
  formatWeight,
  kgToLb,
  kgToUnit,
  lbToKg,
  mToFt,
  msToFpm,
  msToKt,
  unitToKg
} from './units'

describe('weight conversions', () => {
  it('converts kg to lb and back', () => {
    expect(kgToLb(1)).toBeCloseTo(2.2046, 3)
    expect(lbToKg(kgToLb(70))).toBeCloseTo(70, 6)
  })

  it('kgToUnit passes kg through unchanged, and converts to lb otherwise', () => {
    expect(kgToUnit(70, 'kg')).toBe(70)
    expect(kgToUnit(1, 'lb')).toBeCloseTo(2.2046, 3)
  })

  it('unitToKg passes kg through unchanged, and converts from lb otherwise', () => {
    expect(unitToKg(70, 'kg')).toBe(70)
    expect(unitToKg(kgToLb(70), 'lb')).toBeCloseTo(70, 6)
  })
})

describe('distance/speed conversions', () => {
  it('converts metres to feet', () => {
    expect(mToFt(1)).toBeCloseTo(3.2808, 3)
  })

  it('converts m/s to knots', () => {
    expect(msToKt(1)).toBeCloseTo(1.9438, 3)
  })

  it('converts m/s to feet per minute', () => {
    expect(msToFpm(1)).toBeCloseTo(196.85, 1)
  })
})

describe('formatWeight', () => {
  it('renders an em dash for a null value', () => {
    expect(formatWeight(null, 'kg')).toBe('—')
  })

  it('formats kg rounded and thousands-separated', () => {
    expect(formatWeight(65432, 'kg')).toBe('65,432 kg')
  })

  it('formats lb, converted and rounded', () => {
    expect(formatWeight(1000, 'lb')).toBe(`${Math.round(kgToLb(1000)).toLocaleString()} lb`)
  })
})

describe('formatMinutes', () => {
  it('renders an em dash for a null value', () => {
    expect(formatMinutes(null)).toBe('—')
  })

  it('formats whole hours and minutes', () => {
    expect(formatMinutes(125)).toBe('2h 5m')
  })

  it('rounds a fractional minute remainder', () => {
    expect(formatMinutes(90.6)).toBe('1h 31m')
  })

  it('formats zero minutes', () => {
    expect(formatMinutes(0)).toBe('0h 0m')
  })
})

describe('formatAltitude', () => {
  it('formats feet rounded to the nearest 100 (a real flight level), thousands-separated', () => {
    expect(formatAltitude(35000, 'ft')).toBe('35,000 ft')
    expect(formatAltitude(35000.6, 'ft')).toBe('35,000 ft')
  })

  it('rounds an odd feet value from a metric conversion to the nearest 100', () => {
    // 11,300 m converted to feet is ~37,073.49 — no real flight level is that precise.
    expect(formatAltitude(11300 / 0.3048, 'ft')).toBe('37,100 ft')
  })

  it('converts to meters assuming the input is real feet', () => {
    expect(formatAltitude(35000, 'm')).toBe('10,668 m')
  })

  it('formats hybrid as plain feet when no native unit/value is given', () => {
    // Fallback for values with no per-point native unit (e.g. cruise altitude).
    expect(formatAltitude(35000, 'hybrid')).toBe('35,000 ft')
  })

  it('formats hybrid using the native unit/value when given, ignoring altitudeFt', () => {
    // A step climb's `native` field (from parseStepClimbs) is the unit/value the point
    // was actually coded in on the OFP — e.g. metres for a Chinese-airspace metric
    // level — so hybrid shows that directly rather than a feet conversion.
    expect(formatAltitude(37073, 'hybrid', { unit: 'm', value: 11300 })).toBe('11,300 m')
    expect(formatAltitude(33000, 'hybrid', { unit: 'ft', value: 33000 })).toBe('33,000 ft')
  })
})
