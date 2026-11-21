import { describe, expect, it } from 'vitest'
import type { ProcedureSelection } from '@shared/ipc'
import { clearanceDiffers, readNewInfoBoxes, readNewSpeech, resolveAtcClearance } from './atc-clearance'

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
} as ProcedureSelection

describe('clearanceDiffers', () => {
  it('is false when every field already matches', () => {
    expect(
      clearanceDiffers(
        { fields: { departureRunway: '07R', sidIdent: 'OCEAN2B' }, summary: 'SID OCEAN2B' },
        selection
      )
    ).toBe(false)
  })

  it('is true when any field differs', () => {
    expect(
      clearanceDiffers(
        { fields: { departureRunway: '07R', sidIdent: 'BEKOL3B' }, summary: 'SID BEKOL3B' },
        selection
      )
    ).toBe(true)
  })
})

describe('resolveAtcClearance', () => {
  it('offers a departure clearance that changes the SID, keeping when it was given', async () => {
    const offer = await resolveAtcClearance(
      {
        fields: { departureRunway: '07R', sidIdent: 'BEKOL3B' },
        summary: 'SID BEKOL3B',
        sourceTs: 1_759_650_000_000
      },
      selection
    )
    expect(offer).toEqual({
      fields: { departureRunway: '07R', sidIdent: 'BEKOL3B' },
      summary: 'SID BEKOL3B',
      sourceTs: 1_759_650_000_000
    })
  })

  it('offers nothing when the clearance is what is already selected', async () => {
    const offer = await resolveAtcClearance(
      {
        fields: { departureRunway: '07R', sidIdent: 'OCEAN2B' },
        summary: 'SID OCEAN2B',
        sourceTs: 1_759_650_000_000
      },
      selection
    )
    expect(offer).toBeNull()
  })
})

describe('readNewInfoBoxes', () => {
  const star = [
    { title: 'STAR', info: 'UPRS2C' },
    { title: 'Arrival Runway', info: '08' }
  ]

  it('reads a new set of boxes once, with the time BeyondATC set them', () => {
    const read = readNewInfoBoxes('', { infoBoxes: star, infoBoxesAt: 123 }, 999)
    expect(read?.key).toBe(JSON.stringify(star))
    expect(read?.candidate).toMatchObject({ arrivalRunway: '08', sourceTs: 123 })
    expect(readNewInfoBoxes(read?.key ?? '', { infoBoxes: star, infoBoxesAt: 456 }, 999)).toBeNull()
  })

  it('uses the current time when the boxes carry none', () => {
    expect(readNewInfoBoxes('', { infoBoxes: star, infoBoxesAt: null }, 999)?.candidate?.sourceTs).toBe(999)
  })

  it('remembers a set with no clearance in it, so it is not read again', () => {
    const noise = [{ title: 'Center Frequency', info: '132.205' }]
    const read = readNewInfoBoxes('', { infoBoxes: noise, infoBoxesAt: 1 }, 2)
    expect(read).toEqual({ key: JSON.stringify(noise), candidate: null })
  })
})

describe('readNewSpeech', () => {
  const briefing =
    'Hongkong Shuttle 250, leave WL heading 245, expect radar vectors for ILS-Z approach runway 08.'
  const atc = (text: string, ts: number) => ({ speaker: 'atc' as const, text, ts })
  const vectors = { approachIdent: 'ILS Z 08', approachTransition: 'Vectors' }

  it("reads the player's own ATC briefing, with when it was said", () => {
    const read = readNewSpeech('', [atc(briefing, 5_000)], 9_000)
    expect(read?.candidate?.fields).toEqual(vectors)
    expect(read?.candidate?.sourceTs).toBe(5_000)
  })

  it('reads the same briefing once, even when ATC says it again', () => {
    const first = readNewSpeech('', [atc(briefing, 5_000)], 9_000)
    const again = [atc(briefing, 5_000), atc(briefing, 23_000)]
    expect(readNewSpeech(first!.key, again, 30_000)).toBeNull()
  })

  it('reads a briefing again after ATC has said something else', () => {
    const first = readNewSpeech('', [atc(briefing, 5_000)], 9_000)
    const moved = readNewSpeech(
      first!.key,
      [atc(briefing, 5_000), atc('Descend to altitude 1,800m.', 60_000)],
      70_000
    )
    expect(moved).toEqual({ key: '', candidate: null })
    expect(
      readNewSpeech('', [atc(briefing, 5_000), atc('Descend to altitude 1,800m.', 60_000)], 70_000)
    ).toBeNull()
    expect(readNewSpeech('', [atc(briefing, 90_000)], 95_000)?.candidate?.fields).toEqual(vectors)
  })

  it("ignores another aircraft's briefing, which is worded the same", () => {
    const traffic = [
      { speaker: 'atcTraffic' as const, text: 'China Eastern 5771, ' + briefing, ts: 1_000 },
      { speaker: 'traffic' as const, text: briefing, ts: 2_000 },
      { speaker: 'player' as const, text: briefing, ts: 3_000 }
    ]
    expect(readNewSpeech('', traffic, 4_000)).toBeNull()
  })
})
