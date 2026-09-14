import { describe, expect, it } from 'vitest'
import {
  buildTicks,
  computeChartAxisTicks,
  formatTickLabel,
  HOURS_TICK_LADDER,
  MINUTES_TICK_LADDER,
  pickTickStep
} from './chart-ticks'

describe('pickTickStep', () => {
  it('picks the smallest minutes-ladder step that keeps a 20 min flight to ~8 ticks', () => {
    // 20 / 5 = 4 intervals — already within budget at the smallest step.
    expect(pickTickStep(20, MINUTES_TICK_LADDER)).toBe(5)
  })

  it('picks a coarser minutes-ladder step for an 89 min flight', () => {
    // 89 / 5 ≈ 17.8 and 89 / 10 = 8.9 both exceed 8 intervals; 89 / 15 ≈ 5.9 fits.
    expect(pickTickStep(89, MINUTES_TICK_LADDER)).toBe(15)
  })

  it('picks the hours-ladder step for a flight just over the hours-axis threshold (91 min)', () => {
    // 91 min ≈ 1.517 h once the axis switches to hours — 1.517 / 0.25 ≈ 6.07 fits.
    expect(pickTickStep(91 / 60, HOURS_TICK_LADDER)).toBe(0.25)
  })

  it('picks a coarser hours-ladder step for a 3 h flight', () => {
    // 3 / 0.25 = 12 exceeds 8; 3 / 0.5 = 6 fits.
    expect(pickTickStep(3, HOURS_TICK_LADDER)).toBe(0.5)
  })

  it('picks the coarsest hours-ladder step for a 13 h flight', () => {
    // 13 / 1 = 13 exceeds 8; 13 / 2 = 6.5 fits.
    expect(pickTickStep(13, HOURS_TICK_LADDER)).toBe(2)
  })

  it('falls back to the ladder\'s largest step when nothing else keeps it within budget', () => {
    expect(pickTickStep(1000, HOURS_TICK_LADDER)).toBe(2)
  })
})

describe('buildTicks', () => {
  it('starts at 0', () => {
    expect(buildTicks(15, 89)[0]).toBe(0)
  })

  it('the last tick covers the duration, even when it does not divide evenly', () => {
    const ticks = buildTicks(15, 89)
    expect(ticks.at(-1)).toBeGreaterThanOrEqual(89)
    // 89 / 15 = 5.93 -> 6 intervals -> last tick at 90.
    expect(ticks.at(-1)).toBe(90)
  })

  it('every tick is an exact multiple of the step (no floating-point drift)', () => {
    const ticks = buildTicks(0.25, 1.5167)
    for (const t of ticks) {
      expect(Number.isInteger(t / 0.25)).toBe(true)
    }
  })

  it('handles a zero-length duration by returning just the origin', () => {
    expect(buildTicks(5, 0)).toEqual([0])
  })

  it('returns just the origin for a non-positive step', () => {
    expect(buildTicks(0, 100)).toEqual([0])
  })
})

describe('computeChartAxisTicks', () => {
  it('returns minute-unit ticks below the hours-axis switch', () => {
    const { ticksMin, stepDisplay } = computeChartAxisTicks(89, false)
    expect(stepDisplay).toBe(15)
    expect(ticksMin[0]).toBe(0)
    expect(ticksMin.at(-1)).toBeGreaterThanOrEqual(89)
  })

  it('converts hours-ladder ticks back to minutes so they land on the shared tMin field', () => {
    const { ticksMin, stepDisplay } = computeChartAxisTicks(180, true)
    // 3 h -> step 0.5 h -> minute positions are multiples of 30.
    expect(stepDisplay).toBe(0.5)
    expect(ticksMin).toEqual([0, 30, 60, 90, 120, 150, 180])
  })
})

describe('formatTickLabel', () => {
  it('drops trailing zeros', () => {
    expect(formatTickLabel(0.25)).toBe('0.25')
    expect(formatTickLabel(0.5)).toBe('0.5')
    expect(formatTickLabel(1)).toBe('1')
    expect(formatTickLabel(1.5)).toBe('1.5')
  })

  it('formats whole minute ticks with no decimal', () => {
    expect(formatTickLabel(30)).toBe('30')
  })
})
