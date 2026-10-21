import { describe, expect, it } from 'vitest'
import type { NavdataLeg, ProcedureSelection } from './ipc'
import {
  applyClearance,
  assembleRoute,
  emptyProcedureSelection,
  procedureRequests,
  seedProcedureSelectionFromOfp,
  selectionFromFlight
} from './procedure-selection'

// VHHH departure, as SimBrief planned it.
const selection: ProcedureSelection = {
  departureRunway: '07R',
  sidIdent: 'OCEAN2B',
  sidTransition: null,
  starIdent: null,
  starTransition: null,
  approachIdent: null,
  approachTransition: null,
  arrivalIcao: 'WSSS'
}

describe('applyClearance', () => {
  const withTransitions: ProcedureSelection = {
    ...selection,
    sidTransition: 'LAM',
    starIdent: 'LOGA2H',
    starTransition: 'KAIPA',
    approachIdent: 'ILS-Y-27L',
    approachTransition: 'ABC'
  }

  it('drops the old SID transition when a different SID is cleared, and sets the runway and SID', () => {
    const next = applyClearance(withTransitions, { departureRunway: '07L', sidIdent: 'BEKOL3B' })
    expect(next).toMatchObject({ departureRunway: '07L', sidIdent: 'BEKOL3B', sidTransition: null })
    // The arrival side is untouched.
    expect(next).toMatchObject({ starTransition: 'KAIPA', approachTransition: 'ABC' })
  })

  it('keeps the transition when the SID is the same one', () => {
    expect(
      applyClearance(withTransitions, { sidIdent: 'OCEAN2B', departureRunway: '07L' }).sidTransition
    ).toBe('LAM')
  })

  it('drops the STAR transition when a different STAR is cleared', () => {
    expect(applyClearance(withTransitions, { starIdent: 'UPRS2C' })).toMatchObject({
      starIdent: 'UPRS2C',
      starTransition: null
    })
  })

  it('drops the approach transition for a different approach, unless the clearance names one', () => {
    expect(applyClearance(withTransitions, { approachIdent: 'ILS-Z-08' }).approachTransition).toBeNull()
    expect(
      applyClearance(withTransitions, { approachIdent: 'ILS-Z-08', approachTransition: 'SY498' })
        .approachTransition
    ).toBe('SY498')
    expect(applyClearance(withTransitions, { approachIdent: 'ILS-Y-27L' }).approachTransition).toBe('ABC')
  })
})

describe('emptyProcedureSelection', () => {
  it('is all-null', () => {
    expect(emptyProcedureSelection()).toEqual({
      departureRunway: null,
      sidIdent: null,
      sidTransition: null,
      starIdent: null,
      starTransition: null,
      approachIdent: null,
      approachTransition: null,
      arrivalIcao: null
    })
  })
})

describe('seedProcedureSelectionFromOfp', () => {
  it('seeds from SimBrief’s own choice, leaving approach fields null', () => {
    const ofpJson = JSON.stringify({
      general: { sid_ident: 'DET2G', sid_trans: 'CLEEE', star_ident: 'PUCKY1', star_trans: 'WLKES' },
      api_params: { origrwy: '27L', destrwy: '31R' }
    })
    expect(seedProcedureSelectionFromOfp(ofpJson)).toEqual({
      departureRunway: '27L',
      sidIdent: 'DET2G',
      sidTransition: 'CLEEE',
      starIdent: 'PUCKY1',
      starTransition: 'WLKES',
      approachIdent: null,
      approachTransition: null,
      arrivalIcao: null
    })
  })

  it('is all-null for a null OFP', () => {
    expect(seedProcedureSelectionFromOfp(null)).toEqual(emptyProcedureSelection())
  })
})

describe('selectionFromFlight', () => {
  it('reads the seven selected* fields off a flight-shaped object', () => {
    const flight = {
      selectedDepartureRunway: '27R',
      selectedSidIdent: 'BPK7F',
      selectedSidTransition: null,
      selectedStarIdent: 'SIER7B',
      selectedStarTransition: null,
      selectedApproachIdent: 'ILS 07C',
      selectedApproachTransition: 'LIMES',
      selectedArrivalIcao: 'EGKK'
    }
    expect(selectionFromFlight(flight)).toEqual({
      departureRunway: '27R',
      sidIdent: 'BPK7F',
      sidTransition: null,
      starIdent: 'SIER7B',
      starTransition: null,
      approachIdent: 'ILS 07C',
      approachTransition: 'LIMES',
      arrivalIcao: 'EGKK'
    })
  })

  it('reads a pre-1.1.1 flight (no arrival airport recorded) as the filed destination', () => {
    expect(
      selectionFromFlight({
        selectedDepartureRunway: null,
        selectedSidIdent: null,
        selectedSidTransition: null,
        selectedStarIdent: null,
        selectedStarTransition: null,
        selectedApproachIdent: null,
        selectedApproachTransition: null
      }).arrivalIcao
    ).toBeNull()
  })
})

describe('procedureRequests', () => {
  const airports = { depIcao: 'EGLL', arrIcao: 'KJFK', altnIcao: 'KEWR', ofpJson: null }

  it('asks for nothing when nothing is selected', () => {
    expect(procedureRequests(airports, emptyProcedureSelection())).toEqual({
      sid: null,
      star: null,
      approach: null
    })
  })

  it('asks for the SID at the departure with its runway, the STAR and approach at the arrival', () => {
    const requests = procedureRequests(airports, {
      departureRunway: '27L',
      sidIdent: 'BPK7F',
      sidTransition: 'LAM',
      starIdent: 'WOOD1A',
      starTransition: 'WOOD',
      approachIdent: 'ILS 04R',
      approachTransition: 'CAMRN',
      arrivalIcao: null
    })
    expect(requests.sid).toEqual({
      icao: 'EGLL',
      kind: 'sid',
      identifier: 'BPK7F',
      runway: '27L',
      transition: 'LAM'
    })
    // A STAR's legs can live in a runway-specific transition, so the approach's runway filters it.
    expect(requests.star).toEqual({
      icao: 'KJFK',
      kind: 'star',
      identifier: 'WOOD1A',
      runway: '04R',
      transition: 'WOOD'
    })
    expect(requests.approach).toEqual({
      icao: 'KJFK',
      kind: 'approach',
      identifier: 'ILS 04R',
      runway: null,
      transition: 'CAMRN'
    })
  })

  it('asks for the STAR and approach at the alternate when the selection names it', () => {
    const requests = procedureRequests(airports, {
      ...emptyProcedureSelection(),
      starIdent: 'ALT1A',
      approachIdent: 'ILS 04R',
      arrivalIcao: 'KEWR'
    })
    expect(requests.star?.icao).toBe('KEWR')
    expect(requests.approach?.icao).toBe('KEWR')
  })
})

describe('assembleRoute', () => {
  const ofpJson = JSON.stringify({
    general: { sid_ident: 'BPK7F', star_ident: 'WOOD1A' },
    navlog: {
      fix: [
        { ident: 'SIDFIX', pos_lat: '1', pos_long: '1', altitude_feet: '3000', via_airway: 'BPK7F' },
        { ident: 'CRUISE', pos_lat: '2', pos_long: '2', altitude_feet: '35000', via_airway: 'UL9' },
        { ident: 'STARFIX', pos_lat: '3', pos_long: '3', altitude_feet: '9000', via_airway: 'WOOD1A' }
      ]
    }
  })
  const airports = { depIcao: 'EGLL', arrIcao: 'KJFK', altnIcao: 'KEWR', ofpJson }
  const leg = (fixIdent: string): NavdataLeg => ({
    type: 4,
    fixIdent,
    fixType: 'W',
    fixLatitude: 10,
    fixLongitude: 20,
    turnDirection: 0,
    courseDeg: 0,
    altitude1: 0,
    altitude2: 0,
    speedLimit: 0,
    routeDistanceM: 0
  })
  const none = { sid: null, star: null, approach: null }
  const idents = (route: { ident: string }[]): string[] => route.map((w) => w.ident)

  it("keeps SimBrief's own route with nothing fetched", () => {
    expect(idents(assembleRoute(airports, emptyProcedureSelection(), none))).toEqual([
      'SIDFIX',
      'CRUISE',
      'STARFIX'
    ])
  })

  it("replaces SimBrief's SID and STAR with the fetched legs, and adds the approach", () => {
    const selection = {
      ...emptyProcedureSelection(),
      sidIdent: 'NEW1Z',
      starIdent: 'NEW2A',
      approachIdent: 'ILS 04R'
    }
    const route = assembleRoute(airports, selection, {
      sid: [leg('NEWSID')],
      star: [leg('NEWSTAR')],
      approach: [leg('FAF')]
    })
    expect(idents(route)).toEqual(['NEWSID', 'CRUISE', 'NEWSTAR', 'FAF'])
  })

  it("keeps SimBrief's segment when the legs come back empty, but a selected procedure with no legs adds nothing", () => {
    const selection = { ...emptyProcedureSelection(), sidIdent: 'NEW1Z', approachIdent: 'ILS 04R' }
    expect(idents(assembleRoute(airports, selection, { sid: [], star: null, approach: [] }))).toEqual([
      'SIDFIX',
      'CRUISE',
      'STARFIX'
    ])
  })

  it("drops the filed destination's STAR when diverting to the alternate", () => {
    const route = assembleRoute(
      airports,
      { ...emptyProcedureSelection(), starIdent: 'ALT1A', arrivalIcao: 'KEWR' },
      { sid: null, star: [leg('ALTSTAR')], approach: null }
    )
    expect(idents(route)).toEqual(['SIDFIX', 'CRUISE', 'ALTSTAR'])
  })
})
