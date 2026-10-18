import { describe, expect, it } from 'vitest'
import type { NavdataProcedureOption } from '@shared/ipc'
import { INITIAL_ARRIVAL_STATE, stepArrival, type ArrivalLookup } from './arrival-clearance-step'

// EGLL's approaches, trimmed to what is used here.
const EGLL: NavdataProcedureOption[] = [
  { identifier: 'ILS 27L', transition: 'LAM' },
  { identifier: 'ILS 27R', transition: 'LAM' },
  { identifier: 'ILS 27R', transition: 'BIG' }
]
const lookup: ArrivalLookup = { getArrivalIcao: () => 'EGLL', listApproaches: () => EGLL }
const box = (title: string, info: string) => ({ title, info })
const STAR_27R = [box('STAR', 'LOGA2H'), box('Arrival Runway', '27R')]

describe('stepArrival', () => {
  it('reads a STAR clearance and returns a new state, leaving the old one alone', () => {
    const next = stepArrival(INITIAL_ARRIVAL_STATE, { kind: 'boxes', boxes: STAR_27R }, lookup)
    expect(next.clearance).toEqual({
      starIdent: 'LOGA2H',
      runway: '27R',
      approachIdent: null,
      approachTransition: null
    })
    expect(INITIAL_ARRIVAL_STATE.clearance).toBeNull()
    expect(INITIAL_ARRIVAL_STATE.lastBoxesKey).toBe('')
  })

  it('reads an unchanged set of boxes once: the same state comes back', () => {
    const once = stepArrival(INITIAL_ARRIVAL_STATE, { kind: 'boxes', boxes: STAR_27R }, lookup)
    expect(stepArrival(once, { kind: 'boxes', boxes: STAR_27R }, lookup)).toBe(once)
  })

  it('keeps the same clearance object when a new set of boxes changes nothing', () => {
    const once = stepArrival(INITIAL_ARRIVAL_STATE, { kind: 'boxes', boxes: STAR_27R }, lookup)
    const noise = stepArrival(once, { kind: 'boxes', boxes: [box('Center Frequency', '132.205')] }, lookup)
    expect(noise.clearance).toBe(once.clearance)
    expect(noise.lastBoxesKey).not.toBe(once.lastBoxesKey)
  })

  it('names a cleared approach the way the airport navdata does, with the briefed transition', () => {
    let state = stepArrival(INITIAL_ARRIVAL_STATE, { kind: 'boxes', boxes: STAR_27R }, lookup)
    state = stepArrival(
      state,
      { kind: 'boxes', boxes: [box('Landing Runway', '27R'), box('Transition', 'LAM')] },
      lookup
    )
    state = stepArrival(
      state,
      { kind: 'boxes', boxes: [box('Cleared Approach', 'ILS approach runway 27R')] },
      lookup
    )
    expect(state.clearance).toEqual({
      starIdent: 'LOGA2H',
      runway: '27R',
      approachIdent: 'ILS 27R',
      approachTransition: 'LAM'
    })
  })

  it('uses the boxes own wording when no arrival airport is known', () => {
    const noAirport: ArrivalLookup = { getArrivalIcao: () => null, listApproaches: () => EGLL }
    const state = stepArrival(
      INITIAL_ARRIVAL_STATE,
      { kind: 'boxes', boxes: [box('Cleared Approach', 'ILS approach runway 27R')] },
      noAirport
    )
    expect(state.clearance?.runway).toBeNull()
    expect(state.clearance?.approachIdent).toBeTruthy()
  })

  it('drops the approach when a new STAR clearance is for another runway', () => {
    let state = stepArrival(
      INITIAL_ARRIVAL_STATE,
      { kind: 'boxes', boxes: [box('Landing Runway', '27L')] },
      lookup
    )
    state = stepArrival(
      state,
      { kind: 'boxes', boxes: [box('Cleared Approach', 'ILS approach runway 27L')] },
      lookup
    )
    expect(state.clearance?.approachIdent).toBe('ILS 27L')
    state = stepArrival(state, { kind: 'boxes', boxes: STAR_27R }, lookup)
    expect(state.clearance).toEqual({
      starIdent: 'LOGA2H',
      runway: '27R',
      approachIdent: null,
      approachTransition: null
    })
  })

  it('clears at touchdown only, and keeps the boxes already read', () => {
    const once = stepArrival(INITIAL_ARRIVAL_STATE, { kind: 'boxes', boxes: STAR_27R }, lookup)
    expect(stepArrival(once, { kind: 'phase', phase: 'descent' }, lookup)).toBe(once)
    const landed = stepArrival(once, { kind: 'phase', phase: 'landing' }, lookup)
    expect(landed.clearance).toBeNull()
    expect(landed.lastBoxesKey).toBe(once.lastBoxesKey)
    expect(stepArrival(landed, { kind: 'phase', phase: 'landing' }, lookup)).toBe(landed)
  })
})
