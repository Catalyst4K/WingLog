import { describe, expect, it } from 'vitest'
import { parseAtcClearance } from './atcClearanceParser'

describe('parseAtcClearance', () => {
  it('parses a real departure clearance', () => {
    const result = parseAtcClearance('Test 830, Test Delivery, cleared to Pudong via VMR9B departure, runway 20C, climb via SID to 11000 feet, squawk 3136.')
    expect(result).toEqual({
      fields: { sidIdent: 'VMR9B', departureRunway: '20C' },
      summary: 'SID VMR9B, runway 20C'
    })
  })

  it('parses a real STAR clearance without a runway field (nowhere to store one yet)', () => {
    const result = parseAtcClearance('Test 830, cleared AND1 arrival, runway 17R.')
    expect(result).toEqual({
      fields: { starIdent: 'AND1' },
      summary: 'STAR AND1, runway 17R'
    })
  })

  it('parses a real "expect the approach" advisory, including its transition', () => {
    const result = parseAtcClearance('Test 830 Test Approach, QNH 1012 expect the ILS-Z approach runway 17R with the PD201 transition.')
    expect(result).toEqual({
      fields: { approachIdent: 'ILS Z 17R', approachTransition: 'PD201' },
      summary: 'Approach ILS Z 17R via PD201'
    })
  })

  it('parses a real "cleared approach" confirmation with no transition mentioned', () => {
    const result = parseAtcClearance('Test 830, cleared direct PD201, cross PD201 at or above 900m, cleared ILS-Z approach runway 17R.')
    expect(result).toEqual({
      fields: { approachIdent: 'ILS Z 17R' },
      summary: 'Approach ILS Z 17R'
    })
    // The transition key must be absent, not null — a later merge must never erase an
    // already-accepted transition from an earlier "expect..." message.
    expect(result?.fields).not.toHaveProperty('approachTransition')
  })

  it('is case-insensitive', () => {
    const result = parseAtcClearance('test 830, CLEARED AND1 ARRIVAL, RUNWAY 17r.')
    expect(result?.fields).toEqual({ starIdent: 'AND1' })
  })

  it('returns null for an unrelated ATC line (frequency handoff)', () => {
    expect(parseAtcClearance('Test 830, contact Test Radar 134.7.')).toBeNull()
  })

  it('returns null for a pilot readback echoed back as text', () => {
    expect(parseAtcClearance('Climb FL410, Test 830.')).toBeNull()
  })

  it('returns null for an empty string', () => {
    expect(parseAtcClearance('')).toBeNull()
  })
})
