import { describe, expect, it } from 'vitest'
import { parseAtcVectorsBriefing } from './atc-speech-approach'

// Lines as BeyondATC sent them on flight 445 (VHHH-ZJSY, 2026-11-21), callsign HKE250.
describe('parseAtcVectorsBriefing', () => {
  it('reads the approach and the vectors from the arrival briefing', () => {
    expect(
      parseAtcVectorsBriefing(
        'Hongkong Shuttle 250 Sanya Approach, good evening, QNH 1020 expect radar vectors for ILS-Z approach runway 08.'
      )
    ).toEqual({
      fields: { approachIdent: 'ILS Z 08', approachTransition: 'Vectors' },
      summary: 'Approach ILS Z 08 via Vectors'
    })
  })

  it('reads it from the same briefing repeated with a heading', () => {
    expect(
      parseAtcVectorsBriefing(
        'Hongkong Shuttle 250, leave WL heading 245, expect radar vectors for ILS-Z approach runway 08.'
      )?.fields
    ).toEqual({ approachIdent: 'ILS Z 08', approachTransition: 'Vectors' })
  })

  it('keeps an unlettered type and a runway side', () => {
    expect(
      parseAtcVectorsBriefing('QNH 1016 expect radar vectors for ILS approach runway 07L.')?.fields
        .approachIdent
    ).toBe('ILS 07L')
  })

  it.each([
    // Said later, with no approach named: the boxes' own Cleared Approach is what names it.
    'Hongkong Shuttle 250, descend to altitude 1,800m, QNH 1020, vectors for the approach.',
    // The clearance itself: a box carries it.
    'Hongkong Shuttle 250, turn left, heading 115, descend to altitude 900m, cleared ILS-Z approach runway 08.',
    // A transition briefing: its box names the transition.
    'Cathay 334 Heavy Hong Kong Approach, QNH 1016 expect the ILS approach runway 07L.',
    'Hongkong Shuttle 250, contact Sanya Approach 125.550.'
  ])('reads nothing from "%s"', (line) => {
    expect(parseAtcVectorsBriefing(line)).toBeNull()
  })
})
