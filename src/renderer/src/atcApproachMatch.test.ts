import { describe, expect, it } from 'vitest'
import type { NavdataProcedureOption } from '@shared/ipc'
import { parseAtcClearance } from './atcClearanceParser'
import { matchClearanceApproach } from './atcApproachMatch'

// WSSS's real approaches from the sim's navdata (cached 2026-10-02), one row per transition.
const WSSS: NavdataProcedureOption[] = [
  { identifier: 'ILS 02L', transition: 'APIPA' },
  { identifier: 'RNAV 02C', transition: 'SAMKO' },
  { identifier: 'RNAV 02L', transition: 'SAMKO' },
  { identifier: 'RNAV 02L', transition: 'SANAT' },
  { identifier: 'RNAV 02R', transition: null },
  { identifier: 'TYPE 8 20C', transition: 'NYLON' }
]

describe('matchClearanceApproach (WSSS, 2026-10-02)', () => {
  it("turns BeyondATC's spoken R-NAV approach into the sim's own RNAV 02L, with the SANAT transition", () => {
    // Real line from Player.log.
    const parsed = parseAtcClearance(
      'Singapore 831 Super Singapore Approach, QNH 1014 expect the R-NAV approach runway 02L with the SANAT transition.'
    )!
    expect(matchClearanceApproach(parsed, WSSS)).toEqual({
      fields: { approachIdent: 'RNAV 02L', approachTransition: 'SANAT' },
      summary: 'Approach RNAV 02L via SANAT'
    })
  })

  it('matches the cleared-approach line too', () => {
    const parsed = parseAtcClearance(
      'Singapore 831 Super, cleared direct SANAT, cross SANAT at or above 4,000, cleared R-NAV approach runway 02L.'
    )!
    expect(matchClearanceApproach(parsed, WSSS)?.fields).toEqual({ approachIdent: 'RNAV 02L' })
  })

  it('keeps an ILS match exactly as before', () => {
    const parsed = parseAtcClearance('Singapore 831 Super, expect the ILS approach runway 02L.')!
    expect(matchClearanceApproach(parsed, WSSS)?.fields).toEqual({ approachIdent: 'ILS 02L' })
  })

  it("drops a transition the approach doesn't have, keeping the approach", () => {
    const parsed = parseAtcClearance('Singapore 831 Super, expect the R-NAV approach runway 02L with the NYLON transition.')!
    expect(matchClearanceApproach(parsed, WSSS)).toEqual({ fields: { approachIdent: 'RNAV 02L' }, summary: 'Approach RNAV 02L' })
  })

  it('offers nothing for an approach the airport does not have, rather than a name nothing shows', () => {
    const parsed = parseAtcClearance('Singapore 831 Super, expect the VOR approach runway 20L.')!
    expect(matchClearanceApproach(parsed, WSSS)).toBeNull()
  })

  it('passes the update through untouched when the airport has no approaches cached yet', () => {
    const parsed = parseAtcClearance('Singapore 831 Super, expect the R-NAV approach runway 02L with the SANAT transition.')!
    expect(matchClearanceApproach(parsed, [])).toBe(parsed)
  })

  it('leaves updates without an approach alone', () => {
    const parsed = parseAtcClearance('Singapore 831 Super, cleared ELAL1A arrival, runway 02L.')!
    expect(matchClearanceApproach(parsed, WSSS)).toBe(parsed)
  })
})
