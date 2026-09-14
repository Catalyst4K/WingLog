import { describe, expect, it } from 'vitest'
import { isNotailCandidate, matchesFlight, type FlightMatchWindow } from './matcher'
import type { ParsedReceiptFilename } from './filename'

function receipt(overrides: Partial<ParsedReceiptFilename> = {}): ParsedReceiptFilename {
  return { timestampUtc: '2026-09-01T11:00:00Z', icao: 'EGLL', tail: 'G-XWBS', ...overrides }
}

function window(overrides: Partial<FlightMatchWindow> = {}): FlightMatchWindow {
  return {
    depIcao: 'EGLL',
    arrIcao: 'VHHH',
    registration: 'G-XWBS',
    windowStartUtc: '2026-09-01T10:00:00Z',
    windowEndUtc: '2026-09-01T22:00:00Z',
    ...overrides
  }
}

describe('matchesFlight', () => {
  it('matches on exact tail, dep-or-arr ICAO, and a timestamp inside the window', () => {
    expect(matchesFlight(receipt(), window())).toBe(true)
  })

  it('matches case-insensitively on tail', () => {
    expect(matchesFlight(receipt({ tail: 'g-xwbs' }), window())).toBe(true)
  })

  it('matches the arrival ICAO too, not just departure', () => {
    expect(matchesFlight(receipt({ icao: 'VHHH', timestampUtc: '2026-09-01T21:00:00Z' }), window())).toBe(true)
  })

  it('never matches NOTAIL, even with a matching window and ICAO', () => {
    expect(matchesFlight(receipt({ tail: 'NOTAIL' }), window())).toBe(false)
  })

  it('rejects a different tail', () => {
    expect(matchesFlight(receipt({ tail: 'G-OTHR' }), window())).toBe(false)
  })

  it('rejects an ICAO that is neither departure nor arrival', () => {
    expect(matchesFlight(receipt({ icao: 'KJFK' }), window())).toBe(false)
  })

  it('matches within the tolerance just outside the raw window', () => {
    // 1 hour before window start — inside the 2-hour tolerance.
    expect(matchesFlight(receipt({ timestampUtc: '2026-09-01T09:00:00Z' }), window())).toBe(true)
  })

  it('rejects a receipt just outside the tolerance', () => {
    expect(matchesFlight(receipt({ timestampUtc: '2026-09-01T07:00:00Z' }), window())).toBe(false)
    expect(matchesFlight(receipt({ timestampUtc: '2026-09-02T01:00:00Z' }), window())).toBe(false)
  })

  it('rejects when the flight has no window at all', () => {
    expect(matchesFlight(receipt(), window({ windowStartUtc: null, windowEndUtc: null }))).toBe(false)
  })

  it('matches anything before the end when only windowEndUtc is set (no lower bound)', () => {
    expect(
      matchesFlight(receipt({ timestampUtc: '1990-01-01T00:00:00Z' }), window({ windowStartUtc: null }))
    ).toBe(true)
  })

  it('matches anything after the start when only windowStartUtc is set (no upper bound)', () => {
    expect(
      matchesFlight(receipt({ timestampUtc: '2099-01-01T00:00:00Z' }), window({ windowEndUtc: null }))
    ).toBe(true)
  })
})

describe('isNotailCandidate', () => {
  it('offers a NOTAIL receipt matching on time and airport only', () => {
    expect(isNotailCandidate(receipt({ tail: 'NOTAIL' }), window())).toBe(true)
  })

  it('is never true for a receipt that does have a tail', () => {
    expect(isNotailCandidate(receipt(), window())).toBe(false)
  })

  it('still requires the ICAO and window to match', () => {
    expect(isNotailCandidate(receipt({ tail: 'NOTAIL', icao: 'KJFK' }), window())).toBe(false)
  })
})
