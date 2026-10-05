import { describe, expect, it } from 'vitest'
import type { NavdataProcedureOption } from '@shared/ipc'
import { pickDefaultApproachIdentifier } from './route'

function option(identifier: string, transition: string | null = null): NavdataProcedureOption {
  return { identifier, transition }
}

describe('pickDefaultApproachIdentifier', () => {
  it('prefers ILS over LOC and RNAV — real VHHH 07R shape', () => {
    const options = [option('ILS 07R'), option('LOC 07R'), option('RNAV Y 07R'), option('RNAV Z 07R')]
    expect(pickDefaultApproachIdentifier(options)).toBe('ILS 07R')
  })

  it('falls back to LOC when no ILS is present', () => {
    const options = [option('LOC 25L'), option('RNAV Z 25L')]
    expect(pickDefaultApproachIdentifier(options)).toBe('LOC 25L')
  })

  it('falls back to the alphabetically first option when neither ILS nor LOC exists', () => {
    const options = [option('RNAV Z 25R'), option('RNAV Y 25R')]
    expect(pickDefaultApproachIdentifier(options)).toBe('RNAV Y 25R')
  })

  it('returns null for an empty option list', () => {
    expect(pickDefaultApproachIdentifier([])).toBeNull()
  })

  it('dedupes multiple transition rows for the same approach', () => {
    const options = [option('ILS 07C', 'LIMES'), option('ILS 07C', 'TD')]
    expect(pickDefaultApproachIdentifier(options)).toBe('ILS 07C')
  })

  // ZJSY's real runway 08 approaches from the sim's navdata (2026-10-05 VHHH-ZJSY flight).
  // UPRS2C ends at SY498.
  const ZJSY_08 = [
    ...['A', 'D046H', 'HUT1', 'HUT2', 'SYX'].map((t) => option('TYPE 8 08', t)),
    ...['SY462', 'SY935'].map((t) => option('ILS X 08', t)),
    ...['A', 'D046H', 'HUT1', 'HUT2', 'SYX'].map((t) => option('ILS Y 08', t)),
    ...['SY462', 'SY463', 'SY498'].map((t) => option('ILS Z 08', t))
  ]

  it('prefers the approach the STAR leads into (ZJSY UPRS2C ends at SY498: ILS Z 08, not X)', () => {
    expect(pickDefaultApproachIdentifier(ZJSY_08)).toBe('ILS X 08')
    expect(pickDefaultApproachIdentifier(ZJSY_08, 'SY498')).toBe('ILS Z 08')
  })

  it('falls back to the usual order when no approach starts at the STAR end', () => {
    expect(pickDefaultApproachIdentifier(ZJSY_08, 'NOTAFIX')).toBe('ILS X 08')
    expect(pickDefaultApproachIdentifier(ZJSY_08, null)).toBe('ILS X 08')
  })
})
