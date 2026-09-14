import { describe, expect, it } from 'vitest'
import { displayAltitude } from './display-altitude'
import type { TransitionAltitudes } from './route'

// VHHH round trip's real numbers (docs/simconnect-notes.md, 2026-09-13): trans_alt 9,000 ft,
// trans_level 11,000 ft.
const VHHH_TRANSITION: TransitionAltitudes = { transAltFt: 9000, transLevelFt: 11000 }

describe('displayAltitude', () => {
  it('shows true altitude, labelled as such, when there is no pressure-altitude reading (an older flight)', () => {
    const result = displayAltitude({ altitudeM: 12000 / 3.28084, pressureAltitudeM: null, phase: 'cruise' }, VHHH_TRANSITION)
    expect(result.label).toBe('True altitude')
    expect(result.valueFt).toBeCloseTo(12000, 0)
  })

  it('shows true altitude below the climb-side transition altitude', () => {
    const result = displayAltitude(
      { altitudeM: 5000 / 3.28084, pressureAltitudeM: 4800 / 3.28084, phase: 'climb' },
      VHHH_TRANSITION
    )
    expect(result.label).toBe('Altitude')
    expect(result.valueFt).toBeCloseTo(5000, 0)
  })

  it('shows pressure altitude above the climb-side transition altitude', () => {
    const result = displayAltitude(
      { altitudeM: 39500 / 3.28084, pressureAltitudeM: 39000 / 3.28084, phase: 'climb' },
      VHHH_TRANSITION
    )
    expect(result.label).toBe('Altitude')
    expect(result.valueFt).toBeCloseTo(39000, 0)
  })

  it('uses the destination transition level, not the origin transition altitude, once descending', () => {
    // True altitude sits between the two real VHHH figures (9,000/11,000) — only the
    // descent-side bucket (transLevelFt) reads this as still-true-altitude territory.
    const result = displayAltitude(
      { altitudeM: 10000 / 3.28084, pressureAltitudeM: 9800 / 3.28084, phase: 'descent' },
      VHHH_TRANSITION
    )
    expect(result.label).toBe('Altitude')
    expect(result.valueFt).toBeCloseTo(10000, 0)
  })

  it('falls back to a fixed 18,000 ft transition when the flight has no OFP', () => {
    const belowDefault = displayAltitude(
      { altitudeM: 15000 / 3.28084, pressureAltitudeM: 14900 / 3.28084, phase: 'climb' },
      null
    )
    expect(belowDefault.valueFt).toBeCloseTo(15000, 0)

    const aboveDefault = displayAltitude(
      { altitudeM: 20000 / 3.28084, pressureAltitudeM: 19500 / 3.28084, phase: 'climb' },
      null
    )
    expect(aboveDefault.valueFt).toBeCloseTo(19500, 0)
  })
})
