import { describe, expect, it } from 'vitest'
import type { BeyondAtcTranscriptEntry } from '@shared/ipc'
import { buildClearanceReadout } from './beyondAtcClearanceReadout'

function atc(text: string): BeyondAtcTranscriptEntry {
  return { speaker: 'atc', text, ts: 0 }
}

describe('buildClearanceReadout', () => {
  it('extracts SID, runway, altitude and squawk from a real departure clearance', () => {
    const readout = buildClearanceReadout([
      atc('Cathay 116 Heavy, Brisbane Departure, cleared to Sydney via VMR9B departure, runway 01, climb via SID to 11000 feet, squawk 3136.')
    ])

    expect(readout).toEqual({ sidIdent: 'VMR9B', runway: '01', altitudeFt: 11000, squawk: '3136' })
  })

  it('handles a real flight-level departure clearance (VHHH, 2026-09-30)', () => {
    const readout = buildClearanceReadout([
      atc(
        'Hongkong Shuttle 250, Hong Kong Delivery, information H current, cleared to Phoenix airport via PECA1D departure, runway 25C, climb via SID to FL140, squawk 6140.'
      )
    ])
    expect(readout).toEqual({ sidIdent: 'PECA1D', runway: '25C', flightLevel: 140, squawk: '6140' })
  })

  it('keeps SID and runway when the altitude phrasing is unrecognised', () => {
    const readout = buildClearanceReadout([
      atc('Speedbird 1, cleared to Heathrow via ABC1D departure, runway 09L, maintain 5000 until advised, squawk 1234.')
    ])
    expect(readout).toEqual({ sidIdent: 'ABC1D', runway: '09L', squawk: '1234' })
  })

  it('a later clearance in feet replaces an earlier flight level, not both shown', () => {
    const readout = buildClearanceReadout([
      atc('cleared to Phoenix airport via PECA1D departure, runway 25C, climb via SID to FL140, squawk 6140.'),
      atc('cleared to Sydney via VMR9B departure, runway 01, climb via SID to 11000 feet, squawk 3136.')
    ])
    expect(readout).toEqual({ sidIdent: 'VMR9B', runway: '01', altitudeFt: 11000, squawk: '3136' })
  })

  it('extracts STAR and runway from a real arrival clearance, given without an approach yet', () => {
    const readout = buildClearanceReadout([atc('Singapore 830 Heavy, cleared AND1 arrival, runway 17R.')])

    expect(readout).toEqual({ starIdent: 'AND1', runway: '17R' })
  })

  it('reformats a hyphenated approach type into the sim navdata shape, with its transition', () => {
    const readout = buildClearanceReadout([
      atc('Singapore 830 Heavy, Singapore Approach, QNH 1012 expect the ILS-Z approach runway 17R with the PD201 transition.')
    ])

    expect(readout).toEqual({ approachIdent: 'ILS Z 17R', approachTransition: 'PD201', runway: '17R' })
  })

  it('extracts the approach identifier from the later "cleared ... approach" message, skipping the direct/cross clause', () => {
    const readout = buildClearanceReadout([
      atc('Singapore 830 Heavy, cleared direct PD201, cross PD201 at or above 3000 feet, cleared ILS-Z approach runway 17R.')
    ])

    expect(readout).toEqual({ approachIdent: 'ILS Z 17R', runway: '17R' })
  })

  it('extracts the next-frequency handoff', () => {
    const readout = buildClearanceReadout([atc('Singapore 830 Super, contact Singapore Departure 120.3.')])

    expect(readout).toEqual({ nextFrequencyStation: 'Singapore Departure', nextFrequency: '120.3' })
  })

  it('merges fields across multiple clearance messages, later fields overwriting earlier ones for the same key', () => {
    const readout = buildClearanceReadout([
      atc('Singapore 830 Heavy, cleared AND1 arrival, runway 17R.'),
      atc('Singapore 830 Heavy, Singapore Approach, QNH 1012 expect the ILS-Z approach runway 17R with the PD201 transition.')
    ])

    expect(readout).toEqual({ starIdent: 'AND1', approachIdent: 'ILS Z 17R', approachTransition: 'PD201', runway: '17R' })
  })

  it('ignores player and traffic transcript lines', () => {
    const readout = buildClearanceReadout([
      { speaker: 'player', text: 'cleared to Sydney via VMR9B departure, runway 01, climb via SID to 11000 feet, squawk 3136.', ts: 0 },
      { speaker: 'traffic', text: 'cleared AND1 arrival, runway 17R.', ts: 1 }
    ])

    expect(readout).toEqual({})
  })

  it('returns an empty readout for unrecognised or empty transcript text', () => {
    expect(buildClearanceReadout([atc('Cathay 116 Heavy, readability 5.')])).toEqual({})
    expect(buildClearanceReadout([])).toEqual({})
  })
})
