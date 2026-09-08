import { describe, expect, it } from 'vitest'
import { emptyProcedureSelection, seedProcedureSelectionFromOfp, selectionFromFlight } from './procedureSelection'

describe('emptyProcedureSelection', () => {
  it('is all-null', () => {
    expect(emptyProcedureSelection()).toEqual({
      departureRunway: null,
      sidIdent: null,
      sidTransition: null,
      starIdent: null,
      starTransition: null,
      approachIdent: null,
      approachTransition: null
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
      approachTransition: null
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
      selectedApproachTransition: 'LIMES'
    }
    expect(selectionFromFlight(flight)).toEqual({
      departureRunway: '27R',
      sidIdent: 'BPK7F',
      sidTransition: null,
      starIdent: 'SIER7B',
      starTransition: null,
      approachIdent: 'ILS 07C',
      approachTransition: 'LIMES'
    })
  })
})
