import { describe, expect, it } from 'vitest'
import type { NavdataProcedureOption } from '@shared/ipc'
import { pickDefaultApproachIdentifier } from './ProcedureSelector'

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
})
