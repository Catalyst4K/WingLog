import { describe, expect, it } from 'vitest'
import type { ProcedureSelection } from '@shared/ipc'
import type { PlannedRoute } from '@shared/live'
import { emptyProcedureSelection } from '@shared/procedure-selection'
import {
  choose,
  confirmTimeout,
  initialChoice,
  MAX_ATTEMPTS,
  receiveRoute,
  reconnected
} from './selection-sync'

const sel = (sidIdent: string | null, departureRunway: string | null = null): ProcedureSelection => ({
  ...emptyProcedureSelection(),
  sidIdent,
  departureRunway
})
const route = (revision: number, selection: ProcedureSelection): PlannedRoute => ({
  flightId: 250,
  revision,
  selection,
  waypoints: []
})

describe('receiveRoute with nothing pending', () => {
  it("applies a newer route: a change made in the PC's window, on another device, or by BeyondATC there", () => {
    const state = receiveRoute(initialChoice(sel('VILU6Y', '21R')), route(3, sel('VILU1Z', '03L')))
    expect(state).toMatchObject({ selection: sel('VILU1Z', '03L'), applied: 3, pending: null })
  })

  it('ignores a route at or below the revision already applied', () => {
    const applied = receiveRoute(initialChoice(sel('A')), route(5, sel('B')))
    expect(receiveRoute(applied, route(5, sel('C')))).toBe(applied)
    expect(receiveRoute(applied, route(4, sel('C')))).toBe(applied)
  })
})

describe('a choice made on this screen', () => {
  it('is shown at once, and waits for the PC', () => {
    const state = choose(initialChoice(sel('VILU6Y', '21R')), sel('VILU1Z', '03L'))
    expect(state).toMatchObject({
      selection: sel('VILU1Z', '03L'),
      pending: { selection: sel('VILU1Z', '03L'), attempts: 1 },
      unconfirmed: false
    })
  })

  it('is confirmed by the route built from it, which is applied', () => {
    const state = receiveRoute(choose(initialChoice(sel('A')), sel('B')), route(2, sel('B')))
    expect(state).toMatchObject({ selection: sel('B'), applied: 2, pending: null })
  })

  it("is not undone by the echo of an earlier choice, or another screen's, arriving while it waits", () => {
    const waiting = choose(receiveRoute(initialChoice(sel('A')), route(1, sel('A'))), sel('B'))
    const afterEcho = receiveRoute(waiting, route(2, sel('OTHER')))
    expect(afterEcho).toBe(waiting)
    // Its own confirmation still comes through afterwards.
    expect(receiveRoute(afterEcho, route(3, sel('B')))).toMatchObject({
      selection: sel('B'),
      applied: 3,
      pending: null
    })
  })

  it('does nothing when it is the choice already shown, which the PC would have nothing new to confirm', () => {
    const state = initialChoice(sel('A', '21R'))
    expect(choose(state, sel('A', '21R'))).toBe(state)
  })

  it('replaces a choice still waiting with the newer one', () => {
    const state = choose(choose(initialChoice(sel('A')), sel('B')), sel('C'))
    expect(state.pending).toEqual({ selection: sel('C'), attempts: 1 })
  })
})

describe('confirmTimeout', () => {
  it('does nothing when no choice is waiting', () => {
    const state = initialChoice(sel('A'))
    expect(confirmTimeout(state, undefined)).toEqual({ state, resend: null })
  })

  it('sends the choice again, up to MAX_ATTEMPTS sends in all', () => {
    let state = choose(initialChoice(sel('A')), sel('B'))
    const sent: ProcedureSelection[] = [sel('B')]
    for (;;) {
      const next = confirmTimeout(state, undefined)
      if (!next.resend) break
      sent.push(next.resend)
      state = next.state
    }
    expect(sent).toHaveLength(MAX_ATTEMPTS)
    expect(sent.every((s) => s.sidIdent === 'B')).toBe(true)
  })

  it('gives up after the last send: shows what the PC really has, and says so', () => {
    let state = choose(initialChoice(sel('A')), sel('B'))
    const pcHas = route(7, sel('A'))
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) state = confirmTimeout(state, pcHas).state
    const final = confirmTimeout(state, pcHas)
    expect(final.resend).toBeNull()
    expect(final.state).toMatchObject({ selection: sel('A'), applied: 7, pending: null, unconfirmed: true })
  })

  it('keeps what it shows when it gives up before the PC has sent any route', () => {
    let state = choose(initialChoice(sel('A')), sel('B'))
    for (let i = 0; i < MAX_ATTEMPTS; i++) state = confirmTimeout(state, undefined).state
    expect(state).toMatchObject({ selection: sel('B'), pending: null, unconfirmed: true })
  })

  it('clears the notice when the next choice is made', () => {
    let state = choose(initialChoice(sel('A')), sel('B'))
    for (let i = 0; i < MAX_ATTEMPTS; i++) state = confirmTimeout(state, undefined).state
    expect(choose(state, sel('C')).unconfirmed).toBe(false)
  })
})

describe('reconnected', () => {
  it('starts the revision count again, because the PC may have restarted, and has nothing to send', () => {
    const applied = receiveRoute(initialChoice(sel('A')), route(9, sel('B')))
    const back = reconnected(applied)
    expect(back.resend).toBeNull()
    expect(back.state.applied).toBe(0)
    // A restarted PC counts from 1 again, and is heard.
    expect(receiveRoute(back.state, route(1, sel('C'))).selection).toEqual(sel('C'))
  })

  it('sends the choice still waiting at once, counted as an attempt', () => {
    const waiting = choose(initialChoice(sel('A')), sel('B'))
    const back = reconnected(waiting)
    expect(back.resend).toEqual(sel('B'))
    expect(back.state.pending).toEqual({ selection: sel('B'), attempts: 2 })
  })
})
