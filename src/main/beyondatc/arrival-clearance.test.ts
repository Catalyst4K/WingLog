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
