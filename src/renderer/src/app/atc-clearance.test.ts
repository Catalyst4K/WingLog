import { describe, expect, it } from 'vitest'
import type { ProcedureSelection } from '@shared/ipc'
import { clearanceDiffers, readNewInfoBoxes, resolveAtcClearance } from './atc-clearance'

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
  const star = [{ title: 'STAR', info: 'UPRS2C' }, { title: 'Arrival Runway', info: '08' }]

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
