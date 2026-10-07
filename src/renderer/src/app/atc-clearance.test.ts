import { describe, expect, it } from 'vitest'
import type { ProcedureSelection } from '@shared/ipc'
import { clearanceDiffers, resolveAtcClearance } from './atc-clearance'

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
