import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NavdataProcedureOption } from '@shared/ipc'
import { parseAtcBoxClearance } from '@shared/atc-info-boxes'
import { approachForArrivalRunway, starEndFix } from './atc-approach-match'

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
  const clearance = parseAtcBoxClearance([{ title: 'STAR', info: 'LOGA2H' }, { title: 'Arrival Runway', info: '27R' }])!

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
    const noRunway = parseAtcBoxClearance([{ title: 'STAR', info: 'LOGA2H' }])!
    expect(approachForArrivalRunway(noRunway, EGLL, current)).toBe(noRunway)
  })
})

// ZJSY's real runway 08 approaches (2026-10-05 VHHH-ZJSY flight). UPRS2C ends at SY498, which
// only ILS Z 08 starts from.
const ZJSY: NavdataProcedureOption[] = [
  ...['A', 'D046H', 'HUT1', 'HUT2', 'SYX'].map((transition) => ({ identifier: 'TYPE 8 08', transition })),
  ...['SY462', 'SY935'].map((transition) => ({ identifier: 'ILS X 08', transition })),
  ...['A', 'D046H', 'HUT1', 'HUT2', 'SYX'].map((transition) => ({ identifier: 'ILS Y 08', transition })),
  ...['SY462', 'SY463', 'SY498'].map((transition) => ({ identifier: 'ILS Z 08', transition }))
]

describe('approachForArrivalRunway with the STAR end (ZJSY, 2026-10-05)', () => {
  const clearance = parseAtcBoxClearance([{ title: 'STAR', info: 'UPRS2C' }, { title: 'Arrival Runway', info: '08' }])!

  it('moves ILS X 08 to ILS Z 08 via SY498, where UPRS2C ends', () => {
    expect(approachForArrivalRunway(clearance, ZJSY, { approachIdent: 'ILS X 08', approachTransition: null }, 'SY498')).toEqual({
      fields: { starIdent: 'UPRS2C', approachIdent: 'ILS Z 08', approachTransition: 'SY498' },
      summary: 'STAR UPRS2C, runway 08: ILS Z 08 via SY498',
      arrivalRunway: '08'
    })
  })

  it('picks the connecting approach when none is selected or another runway is', () => {
    for (const approachIdent of [null, 'ILS 26']) {
      const result = approachForArrivalRunway(clearance, ZJSY, { approachIdent, approachTransition: null }, 'SY498')
      expect(result.fields).toMatchObject({ approachIdent: 'ILS Z 08', approachTransition: 'SY498' })
    }
  })

  it('keeps a selected approach that already connects to the STAR', () => {
    expect(approachForArrivalRunway(clearance, ZJSY, { approachIdent: 'ILS Z 08', approachTransition: 'SY498' }, 'SY498')).toBe(clearance)
  })

  it('keeps the selected approach when nothing on that runway starts at the STAR end', () => {
    expect(approachForArrivalRunway(clearance, ZJSY, { approachIdent: 'ILS X 08', approachTransition: 'SY462' }, 'NOTAFIX')).toBe(clearance)
  })
})

describe('starEndFix', () => {
  afterEach(() => vi.unstubAllGlobals())

  function stubLegs(result: Promise<{ fixIdent: string | null }[]>): ReturnType<typeof vi.fn> {
    const navdataGetProcedureWaypoints = vi.fn(() => result)
    vi.stubGlobal('window', { winglog: { navdataGetProcedureWaypoints } })
    return navdataGetProcedureWaypoints
  }

  it("returns the STAR's last named fix for the cleared runway", async () => {
    const get = stubLegs(Promise.resolve([{ fixIdent: 'UPRIS' }, { fixIdent: 'SY497' }, { fixIdent: 'SY498' }, { fixIdent: null }]))
    const clearance = parseAtcBoxClearance([{ title: 'STAR', info: 'UPRS2C' }, { title: 'Arrival Runway', info: '08' }])!
    expect(await starEndFix('ZJSY', clearance)).toBe('SY498')
    expect(get).toHaveBeenCalledWith('ZJSY', 'star', 'UPRS2C', '08')
  })

  it('returns null with no STAR, no legs, or a navdata error', async () => {
    const clearance = parseAtcBoxClearance([{ title: 'STAR', info: 'UPRS2C' }, { title: 'Arrival Runway', info: '08' }])!
    stubLegs(Promise.resolve([]))
    expect(await starEndFix('ZJSY', clearance)).toBeNull()
    stubLegs(Promise.reject(new Error('no navdata')))
    expect(await starEndFix('ZJSY', clearance)).toBeNull()
    const get = stubLegs(Promise.resolve([{ fixIdent: 'X' }]))
    expect(await starEndFix('ZJSY', { fields: {}, summary: '' })).toBeNull()
    expect(get).not.toHaveBeenCalled()
  })
})
