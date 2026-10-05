import { describe, expect, it, vi } from 'vitest'
import type { NavdataProcedureOption } from '@shared/ipc'
import { ArrivalClearanceTracker } from './arrival-clearance'

// EGLL's real approaches (cached on flight 229, 2026-10-05), trimmed to what's used here.
const EGLL: NavdataProcedureOption[] = [
  { identifier: 'ILS 27L', transition: 'LAM' },
  { identifier: 'ILS 27R', transition: 'LAM' },
  { identifier: 'ILS 27R', transition: 'BIG' },
  { identifier: 'RNAV 27R', transition: null }
]

function tracker(): { tracker: ArrivalClearanceTracker; changes: unknown[] } {
  const t = new ArrivalClearanceTracker({ getArrivalIcao: () => 'EGLL', listApproaches: () => EGLL })
  const changes: unknown[] = []
  t.on('clearance', (c) => changes.push(c))
  return { tracker: t, changes }
}

// BeyondATC's InfoBox sets, in the real titles (VHHH-ZJSY flight 230, 2026-10-05), for EGLL's
// flight 229 clearances.
const STAR_27R = [{ title: 'STAR', info: 'LOGA2H' }, { title: 'Arrival Runway', info: '27R' }]
const box = (title: string, info: string) => ({ title, info })

describe('ArrivalClearanceTracker', () => {
  it("keeps flight 229's STAR/runway clearance (EGLL, 2026-10-05)", () => {
    const { tracker: t } = tracker()
    t.onInfoBoxes(STAR_27R)
    expect(t.getClearance()).toEqual({ starIdent: 'LOGA2H', runway: '27R', approachIdent: null, approachTransition: null })
  })

  it('keeps it across later box sets with no procedure (the latest-instruction card does not)', () => {
    const { tracker: t } = tracker()
    t.onInfoBoxes(STAR_27R)
    t.onInfoBoxes([box('Center Frequency', '132.205')])
    t.onInfoBoxes([box('Descend to', 'FL110'), box('QNH', 'QNH 1013')])
    expect(t.getClearance()?.starIdent).toBe('LOGA2H')
  })

  it("adds the transition from the briefing and the approach once cleared, named the sim's way", () => {
    const { tracker: t } = tracker()
    t.onInfoBoxes(STAR_27R)
    t.onInfoBoxes([box('Approach Type', 'Procedure'), box('Landing Runway', '27R'), box('Transition', 'LAM')])
    t.onInfoBoxes([box('Cleared Approach', 'ILS approach runway 27R')])
    expect(t.getClearance()).toEqual({ starIdent: 'LOGA2H', runway: '27R', approachIdent: 'ILS 27R', approachTransition: 'LAM' })
  })

  it("drops the approach when a new STAR clearance changes the runway, and keeps it when it doesn't", () => {
    const { tracker: t } = tracker()
    t.onInfoBoxes([box('Landing Runway', '27L'), box('Transition', 'LAM')])
    t.onInfoBoxes([box('Cleared Approach', 'ILS approach runway 27L')])
    t.onInfoBoxes(STAR_27R)
    expect(t.getClearance()).toEqual({ starIdent: 'LOGA2H', runway: '27R', approachIdent: null, approachTransition: null })

    t.onInfoBoxes([box('Cleared Approach', 'ILS approach runway 27R')])
    t.onInfoBoxes([box('STAR', 'LOGA2H'), box('Arrival Runway', '27R'), box('QNH', 'QNH 1013')])
    expect(t.getClearance()?.approachIdent).toBe('ILS 27R')
  })

  it('clears at touchdown, and only then', () => {
    const { tracker: t, changes } = tracker()
    t.onInfoBoxes(STAR_27R)
    t.onPhase('descent')
    expect(t.getClearance()).not.toBeNull()
    t.onPhase('landing')
    expect(t.getClearance()).toBeNull()
    expect(changes.at(-1)).toBeNull()
  })

  it('ignores the departure clearance and other phases', () => {
    const { tracker: t, changes } = tracker()
    t.onInfoBoxes([box('Taxi to Runway', '34R'), box('SID', 'NOPI2Y'), box('Altitude Clearance', '13000ft'), box('Squawk', '4112')])
    t.onInfoBoxes([box('Taxi to Gate', 'Gate 411'), box('Taxi Via 1', 'A')])
    expect(t.getClearance()).toBeNull()
    expect(changes).toEqual([])
  })

  it('emits only on a real change', () => {
    const { tracker: t, changes } = tracker()
    t.onInfoBoxes(STAR_27R)
    t.onInfoBoxes([...STAR_27R, box('QNH', 'QNH 1013')])
    expect(changes).toHaveLength(1)
  })

  it("shows BeyondATC's own approach name when navdata can't match it", () => {
    const t = new ArrivalClearanceTracker({ getArrivalIcao: () => null, listApproaches: vi.fn(() => []) })
    t.onInfoBoxes([box('Cleared Approach', 'ILS approach runway 27R')])
    expect(t.getClearance()?.approachIdent).toBe('ILS 27R')
  })
})

// ZJSY's real runway 08 approaches and box sets (VHHH-ZJSY flight 230, 2026-10-05, main.log).
const ZJSY: NavdataProcedureOption[] = [
  { identifier: 'ILS X 08', transition: 'SY462' },
  { identifier: 'ILS Z 08', transition: 'SY498' }
]

describe('ArrivalClearanceTracker from InfoBoxes', () => {
  function zjsy(): ArrivalClearanceTracker {
    return new ArrivalClearanceTracker({ getArrivalIcao: () => 'ZJSY', listApproaches: () => ZJSY })
  }

  it("follows flight 230's real box sequence from STAR to cleared approach", () => {
    const t = zjsy()
    t.onInfoBoxes([{ title: 'STAR', info: 'UPRS2C' }, { title: 'Arrival Runway', info: '08' }])
    expect(t.getClearance()).toEqual({ starIdent: 'UPRS2C', runway: '08', approachIdent: null, approachTransition: null })

    t.onInfoBoxes([{ title: 'Landing Runway', info: '08' }, { title: 'QNH', info: 'QNH 1014' }])
    t.onInfoBoxes([{ title: 'Descend to', info: '3,000m' }, { title: 'QNH', info: 'QNH 1014' }])
    t.onInfoBoxes([
      { title: 'Approach Type', info: 'Procedure' },
      { title: 'Landing Runway', info: '08' },
      { title: 'Transition', info: 'SY498' },
      { title: 'QNH', info: 'QNH 1014' }
    ])
    expect(t.getClearance()).toEqual({ starIdent: 'UPRS2C', runway: '08', approachIdent: null, approachTransition: 'SY498' })

    t.onInfoBoxes([{ title: 'Cross SY498', info: 'At or above 1,200m' }, { title: 'Cleared Approach', info: 'ILS-Z approach runway 08' }])
    expect(t.getClearance()).toEqual({ starIdent: 'UPRS2C', runway: '08', approachIdent: 'ILS Z 08', approachTransition: 'SY498' })

    // Later sets with no procedure leave it alone.
    t.onInfoBoxes([{ title: 'Cleared for Landing', info: '08' }])
    expect(t.getClearance()?.approachIdent).toBe('ILS Z 08')
  })

  it('reads each box set once, so a repeat does not undo a later change', () => {
    const t = zjsy()
    const star = [{ title: 'STAR', info: 'UPRS2C' }, { title: 'Arrival Runway', info: '08' }]
    t.onInfoBoxes(star)
    t.onInfoBoxes([{ title: 'Cleared Approach', info: 'ILS-Z approach runway 08' }])
    t.onInfoBoxes([{ title: 'Cleared Approach', info: 'ILS-Z approach runway 08' }])
    expect(t.getClearance()?.approachIdent).toBe('ILS Z 08')
  })
})
