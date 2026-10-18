import { describe, expect, it } from 'vitest'
import { airacCycleStart, predatesCurrentCycle } from './airac'

const day = (iso: string): Date => new Date(`${iso}T12:00:00Z`)

describe('airacCycleStart', () => {
  it('gives the published effective dates of the 2026 cycles', () => {
    // AIRAC 2601 to 2613: Jan 22, Feb 19, Mar 19, Apr 16, May 14, Jun 11, Jul 9, Aug 6, Sep 3, Oct 1, Oct 29, Nov 26, Dec 24.
    const published = [
      '01-22',
      '02-19',
      '03-19',
      '04-16',
      '05-14',
      '06-11',
      '07-09',
      '08-06',
      '09-03',
      '10-01',
      '10-29',
      '11-26',
      '12-24'
    ]
    for (const md of published) {
      expect(airacCycleStart(day(`2026-${md}`)).toISOString()).toBe(`2026-${md}T00:00:00.000Z`)
    }
  })

  it('holds a cycle until the day before the next, and changes at midnight UTC', () => {
    expect(airacCycleStart(new Date('2026-10-28T23:59:59Z')).toISOString()).toBe('2026-10-01T00:00:00.000Z')
    expect(airacCycleStart(new Date('2026-10-29T00:00:00Z')).toISOString()).toBe('2026-10-29T00:00:00.000Z')
  })

  it('knows the cycle SimBrief reported on 2 September 2026 (AIRAC 2608, from 6 August)', () => {
    expect(airacCycleStart(day('2026-09-02')).toISOString()).toBe('2026-08-06T00:00:00.000Z')
  })

  it('works before the reference date as well', () => {
    expect(airacCycleStart(day('2024-12-26')).toISOString()).toBe('2024-12-26T00:00:00.000Z')
    expect(airacCycleStart(day('2025-01-22')).toISOString()).toBe('2024-12-26T00:00:00.000Z')
  })
})

describe('predatesCurrentCycle', () => {
  it('is true once a new cycle has taken effect since the fetch, false within the same cycle', () => {
    expect(predatesCurrentCycle('2026-09-20T10:00:00.000Z', day('2026-10-02'))).toBe(true)
    expect(predatesCurrentCycle('2026-10-01T00:00:00.000Z', day('2026-10-28'))).toBe(false)
    expect(predatesCurrentCycle('2026-10-07T10:00:00.000Z', day('2026-10-28'))).toBe(false)
    expect(predatesCurrentCycle('2026-10-28T10:00:00.000Z', day('2026-10-29'))).toBe(true)
  })

  it('ignores a time that does not parse', () => {
    expect(predatesCurrentCycle('not a time', day('2026-10-02'))).toBe(false)
  })
})
