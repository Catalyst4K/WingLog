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

const atc = (text: string, ts: number) => ({ speaker: 'atc' as const, text, ts })

describe('ArrivalClearanceTracker', () => {
  it("keeps flight 229's real STAR/runway clearance (EGLL, 2026-10-05)", () => {
    const { tracker: t } = tracker()
    t.onTranscript([atc('Koreanair 443 Heavy, cleared LOGA2H arrival, runway 27R.', 1000)])
    expect(t.getClearance()).toEqual({ starIdent: 'LOGA2H', runway: '27R', approachIdent: null, approachTransition: null })
  })

  it('keeps it across later, unrelated ATC lines (the latest-instruction card does not)', () => {
    const { tracker: t } = tracker()
    t.onTranscript([atc('Koreanair 443 Heavy, cleared LOGA2H arrival, runway 27R.', 1000)])
    t.onTranscript([
      atc('Koreanair 443 Heavy, cleared LOGA2H arrival, runway 27R.', 1000),
      atc('Koreanair 443 Heavy, contact Maastricht Radar 132.205.', 2000),
      atc('Koreanair 443 Heavy, report ready for descent.', 3000)
    ])
    expect(t.getClearance()?.starIdent).toBe('LOGA2H')
  })

  it("adds the approach and transition once given, named the sim's way", () => {
    const { tracker: t } = tracker()
    t.onTranscript([atc('Koreanair 443 Heavy, cleared LOGA2H arrival, runway 27R.', 1000)])
    t.onTranscript([atc('Koreanair 443 Heavy, expect the ILS approach runway 27R with the LAM transition.', 2000)])
    expect(t.getClearance()).toEqual({ starIdent: 'LOGA2H', runway: '27R', approachIdent: 'ILS 27R', approachTransition: 'LAM' })
  })

  it('keeps a known transition when a later line names the same approach without one', () => {
    const { tracker: t } = tracker()
    t.onTranscript([atc('Koreanair 443 Heavy, expect the ILS approach runway 27R with the LAM transition.', 1000)])
    t.onTranscript([atc('Koreanair 443 Heavy, cleared ILS approach runway 27R.', 2000)])
    expect(t.getClearance()?.approachTransition).toBe('LAM')
  })

  it("drops the approach when a new STAR clearance changes the runway, and keeps it when it doesn't", () => {
    const { tracker: t } = tracker()
    t.onTranscript([atc('Koreanair 443 Heavy, expect the ILS approach runway 27L with the LAM transition.', 1000)])
    t.onTranscript([atc('Koreanair 443 Heavy, cleared LOGA2H arrival, runway 27R.', 2000)])
    expect(t.getClearance()).toEqual({ starIdent: 'LOGA2H', runway: '27R', approachIdent: null, approachTransition: null })

    t.onTranscript([atc('Koreanair 443 Heavy, expect the ILS approach runway 27R with the LAM transition.', 3000)])
    t.onTranscript([atc('Koreanair 443 Heavy, cleared LOGA2H arrival, runway 27R.', 4000)])
    expect(t.getClearance()?.approachIdent).toBe('ILS 27R')
  })

  it('clears at touchdown, and only then', () => {
    const { tracker: t, changes } = tracker()
    t.onTranscript([atc('Koreanair 443 Heavy, cleared LOGA2H arrival, runway 27R.', 1000)])
    t.onPhase('descent')
    expect(t.getClearance()).not.toBeNull()
    t.onPhase('landing')
    expect(t.getClearance()).toBeNull()
    expect(changes.at(-1)).toBeNull()
  })

  it('ignores departure clearances, traffic, pilot lines and anything already seen', () => {
    const { tracker: t, changes } = tracker()
    t.onTranscript([
      atc('Koreanair 443 Heavy, Incheon Delivery, cleared to Heathrow airport via NOPI2Y departure, runway 34R, climb via SID to 13000 feet, squawk 4112.', 1000),
      { speaker: 'atcTraffic', text: 'Other 42, cleared LOGA2H arrival, runway 27L.', ts: 2000 },
      { speaker: 'player', text: 'Cleared LOGA2H arrival, runway 27R, Koreanair 443 Heavy.', ts: 3000 }
    ])
    expect(t.getClearance()).toBeNull()
    expect(changes).toEqual([])
  })

  it('emits only on a real change', () => {
    const { tracker: t, changes } = tracker()
    t.onTranscript([atc('Koreanair 443 Heavy, cleared LOGA2H arrival, runway 27R.', 1000)])
    t.onTranscript([atc('Koreanair 443 Heavy, cleared LOGA2H arrival, runway 27R.', 2000)])
    expect(changes).toHaveLength(1)
  })

  it("shows ATC's own approach name when navdata can't match it", () => {
    const t = new ArrivalClearanceTracker({ getArrivalIcao: () => null, listApproaches: vi.fn(() => []) })
    t.onTranscript([atc('Koreanair 443 Heavy, expect the ILS approach runway 27R with the LAM transition.', 1000)])
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

  it('ignores ATC speech once BeyondATC has sent boxes', () => {
    const t = zjsy()
    t.onInfoBoxes([{ title: 'STAR', info: 'UPRS2C' }, { title: 'Arrival Runway', info: '08' }])
    t.onTranscript([atc('Hongkong Shuttle 250, cleared UPRS3D arrival, runway 26.', 1000)])
    expect(t.getClearance()).toMatchObject({ starIdent: 'UPRS2C', runway: '08' })
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
