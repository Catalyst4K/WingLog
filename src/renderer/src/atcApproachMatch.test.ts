import { describe, expect, it } from 'vitest'
import type { NavdataProcedureOption } from '@shared/ipc'
import { parseAtcClearance } from '@shared/atc-clearance-parser'
import { approachForArrivalRunway } from './atcApproachMatch'

// EGLL's real approaches from the sim's navdata (cached on the 2026-10-05 RKSI-EGLL flight):
// every ILS and LOC has the same six transitions, RNAVs have none. LOGA2H ends at LAM.
const EGLL_TRANSITIONS = ['BIG', 'BNN', 'CHT', 'EPM', 'LAM', 'OCK']
const EGLL: NavdataProcedureOption[] = [
  ...['ILS 09L', 'ILS 09R', 'ILS 27L', 'ILS 27R', 'LOC 09L', 'LOC 09R', 'LOC 27L', 'LOC 27R'].flatMap((identifier) =>
    EGLL_TRANSITIONS.map((transition) => ({ identifier, transition }))
  ),
  ...['RNAV 09L', 'RNAV 09R', 'RNAV 27L', 'RNAV 27R'].map((identifier) => ({ identifier, transition: null }))
]

describe('approachForArrivalRunway (EGLL, 2026-10-05)', () => {
  const clearance = parseAtcClearance('Koreanair 443 Heavy, cleared LOGA2H arrival, runway 27R.')!

  it('moves a planned ILS 27L via LAM to ILS 27R via LAM when ATC gives the STAR with runway 27R', () => {
    expect(approachForArrivalRunway(clearance, EGLL, { approachIdent: 'ILS 27L', approachTransition: 'LAM' })).toEqual({
      fields: { starIdent: 'LOGA2H', approachIdent: 'ILS 27R', approachTransition: 'LAM' },
      summary: 'STAR LOGA2H, runway 27R: ILS 27R via LAM',
      arrivalRunway: '27R'
    })
  })

  it('leaves the transition empty for the STAR to fill when the new approach lacks the current one', () => {
    const result = approachForArrivalRunway(clearance, EGLL, { approachIdent: 'RNAV 27L', approachTransition: null })
    expect(result.fields).toEqual({ starIdent: 'LOGA2H', approachIdent: 'ILS 27R', approachTransition: null })
    const unknown = approachForArrivalRunway(clearance, EGLL, { approachIdent: 'ILS 27L', approachTransition: 'NOTAFIX' })
    expect(unknown.fields.approachTransition).toBeNull()
  })

  it('picks an approach when none is selected yet', () => {
    const result = approachForArrivalRunway(clearance, EGLL, { approachIdent: null, approachTransition: null })
    expect(result.fields.approachIdent).toBe('ILS 27R')
  })

  it('keeps the selected approach when it is already for the cleared runway, even a non-ILS one', () => {
    expect(approachForArrivalRunway(clearance, EGLL, { approachIdent: 'RNAV 27R', approachTransition: null })).toBe(clearance)
  })

  it('changes nothing with no approach list, no approach for that runway, or no runway in the clearance', () => {
    const current = { approachIdent: 'ILS 27L', approachTransition: 'LAM' }
    expect(approachForArrivalRunway(clearance, [], current)).toBe(clearance)
    expect(approachForArrivalRunway(clearance, EGLL.filter((o) => !o.identifier.endsWith('27R')), current)).toBe(clearance)
    const noRunway = parseAtcClearance('Koreanair 443 Heavy, cleared LOGA2H arrival.')!
    expect(approachForArrivalRunway(noRunway, EGLL, current)).toBe(noRunway)
  })
})
