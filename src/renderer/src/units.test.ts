import { describe, expect, it } from 'vitest'
import {
  formatAltitude,
  formatCentrelineOffset,
  formatMinutes,
  formatPitchDeg,
  formatRunwayDistance,
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

describe('formatRunwayDistance', () => {
  it('formats metres directly, thousands-separated', () => {
    expect(formatRunwayDistance(1234, 'm')).toBe('1,234 m')
  })

  it('converts to feet, rounded and thousands-separated', () => {
    expect(formatRunwayDistance(400, 'ft')).toBe(`${Math.round(mToFt(400)).toLocaleString()} ft`)
  })
})

describe('formatPitchDeg', () => {
  it(
    'negates the SimVar-native sign (negative = nose-up) so a flare reads as a positive ' +
      'nose-up number, per normal pilot usage (Callum, 2026-09-13)',
    () => {
      expect(formatPitchDeg(-4.2)).toBe('4.2°')
    }
  )

  it('shows a nose-down touchdown (positive SimVar value) as negative', () => {
    expect(formatPitchDeg(2)).toBe('-2.0°')
  })

  it('formats a level touchdown as 0.0°, not -0.0°', () => {
    expect(formatPitchDeg(0)).toBe('0.0°')
  })
})

describe('formatCentrelineOffset', () => {
  it('shows a positive offset as right', () => {
    expect(formatCentrelineOffset(3.6576, 'ft')).toBe('12 ft R')
  })

  it('shows a negative offset as left, magnitude only', () => {
    expect(formatCentrelineOffset(-2.4384, 'ft')).toBe('8 ft L')
  })

  it('formats in metres without converting', () => {
    expect(formatCentrelineOffset(-5, 'm')).toBe('5 m L')
  })

  it('shows no side letter exactly on the centreline', () => {
    expect(formatCentrelineOffset(0, 'ft')).toBe('0 ft')
  })
})
