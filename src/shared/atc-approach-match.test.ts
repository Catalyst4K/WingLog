import { describe, expect, it } from 'vitest'
import type { NavdataProcedureOption } from './ipc'
import { parseAtcBoxClearance } from './atc-info-boxes'
import { parseAtcVectorsBriefing } from './atc-speech-approach'
import { matchClearanceApproach } from './atc-approach-match'

// WSSS's real approaches from the sim's navdata (cached), one row per transition.
const WSSS: NavdataProcedureOption[] = [
  { identifier: 'ILS 02L', transition: 'APIPA' },
  { identifier: 'RNAV 02C', transition: 'SAMKO' },
  { identifier: 'RNAV 02L', transition: 'SAMKO' },
  { identifier: 'RNAV 02L', transition: 'SANAT' },
  { identifier: 'RNAV 02R', transition: null },
  { identifier: 'TYPE 8 20C', transition: 'NYLON' }
]

/** BeyondATC's `Cleared Approach` box (+ `Transition`), in the real ZJSY shape. */
const cleared = (approach: string, transition?: string) =>
  parseAtcBoxClearance([
    { title: 'Cleared Approach', info: approach },
    ...(transition ? [{ title: 'Transition', info: transition }] : [])
  ])!

describe('matchClearanceApproach (WSSS, 2026-10-02)', () => {
  it("turns BeyondATC's R-NAV approach into the sim's own RNAV 02L, with the SANAT transition", () => {
    expect(matchClearanceApproach(cleared('R-NAV approach runway 02L', 'SANAT'), WSSS)).toEqual({
      fields: { approachIdent: 'RNAV 02L', approachTransition: 'SANAT' },
      summary: 'Approach RNAV 02L via SANAT'
    })
  })

  it('keeps an ILS match exactly as named', () => {
    expect(matchClearanceApproach(cleared('ILS approach runway 02L'), WSSS)?.fields).toEqual({
      approachIdent: 'ILS 02L'
    })
  })

  it("drops a transition the approach doesn't have, keeping the approach", () => {
    expect(matchClearanceApproach(cleared('R-NAV approach runway 02L', 'NYLON'), WSSS)?.fields).toEqual({
      approachIdent: 'RNAV 02L'
    })
  })

  it('offers nothing for an approach the airport does not have, rather than a name nothing shows', () => {
    expect(matchClearanceApproach(cleared('VOR approach runway 20L'), WSSS)).toBeNull()
  })

  it('passes the update through untouched when the airport has no approaches cached yet', () => {
    const update = cleared('R-NAV approach runway 02L', 'SANAT')
    expect(matchClearanceApproach(update, [])).toBe(update)
  })

  it('leaves updates without an approach alone', () => {
    const star = parseAtcBoxClearance([
      { title: 'STAR', info: 'ELAL1A' },
      { title: 'Arrival Runway', info: '02L' }
    ])!
    expect(matchClearanceApproach(star, WSSS)).toBe(star)
  })
})

describe('matchClearanceApproach with vectors (ZJSY, flight 445, 2026-11-21)', () => {
  const ZJSY: NavdataProcedureOption[] = [
    { identifier: 'ILS X 08', transition: 'SY935' },
    { identifier: 'ILS Z 08', transition: 'SY498' },
    { identifier: 'ILS Z 26', transition: 'SY501' }
  ]
  const briefed = () =>
    parseAtcVectorsBriefing('QNH 1020 expect radar vectors for ILS-Z approach runway 08.')!

  it('keeps Vectors, which the navdata never lists as a transition', () => {
    expect(matchClearanceApproach(briefed(), ZJSY)).toEqual({
      fields: { approachIdent: 'ILS Z 08', approachTransition: 'Vectors' },
      summary: 'Approach ILS Z 08 via Vectors'
    })
  })

  it('offers nothing for an approach the airport does not have', () => {
    expect(matchClearanceApproach(briefed(), [{ identifier: 'ILS X 08', transition: 'SY935' }])).toBeNull()
  })
})
