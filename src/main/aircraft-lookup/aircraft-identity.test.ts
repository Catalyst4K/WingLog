import { describe, expect, it } from 'vitest'
import { parseAircraftIdentity } from './aircraft-identity'

// The exact three real captured values from flightdeck-backend's free-flight-tracking.md
// "What the sim actually reports" table (flight-captures/, 2026-09-14) — not synthesized
// shapes, so this also stands as a live check that the vendored CSV still resolves them.
describe('parseAircraftIdentity (real captured values)', () => {
  it('unwraps an ATCCOM localisation token and resolves the ambiguous A320/A20N variant', () => {
    const result = parseAircraftIdentity({
      atcId: 'G-EUYY',
      atcModel: 'ATCCOM.AC_MODEL A320.0.text',
      title: 'FenixA320 IAE SL'
    })
    expect(result.registration).toBe('G-EUYY')
    expect(result.icaoType).toBe('A320') // exact-normalized match beats the "A320neo" substring one
    expect(result.icaoTypeAmbiguous).toBe(true)
  })

  it('resolves the same ATCCOM token for a different registration identically', () => {
    const result = parseAircraftIdentity({
      atcId: 'F-WWTD',
      atcModel: 'ATCCOM.AC_MODEL A320.0.text',
      title: 'FenixA320 IAE WF'
    })
    expect(result.registration).toBe('F-WWTD')
    expect(result.icaoType).toBe('A320')
    expect(result.icaoTypeAmbiguous).toBe(true)
  })

  it('resolves a raw marketing-name atcModel to its ICAO designator unambiguously', () => {
    const result = parseAircraftIdentity({
      atcId: 'F-WWTS',
      atcModel: 'A350-900',
      title: 'A350-900 (Default Cabin)'
    })
    expect(result.registration).toBe('F-WWTS')
    expect(result.icaoType).toBe('A359')
    expect(result.icaoTypeAmbiguous).toBe(false) // both matching rows share the one A359 type
  })
})

describe('parseAircraftIdentity (edge cases)', () => {
  it('passes the registration through untouched, including whitespace trimming', () => {
    const result = parseAircraftIdentity({ atcId: '  G-ABCD  ', atcModel: 'B738', title: '' })
    expect(result.registration).toBe('G-ABCD')
  })

  it('leaves icaoType null when the query matches nothing in the vendored list', () => {
    const result = parseAircraftIdentity({ atcId: 'N12345', atcModel: 'TotallyMadeUpTypeXYZ', title: '' })
    expect(result.icaoType).toBeNull()
    expect(result.icaoTypeAmbiguous).toBe(false)
  })

  it('leaves icaoType null for a query too short to search (icao-types.ts requires length >= 2)', () => {
    const result = parseAircraftIdentity({ atcId: 'N1', atcModel: 'X', title: '' })
    expect(result.icaoType).toBeNull()
  })

  it('resolves an unambiguous exact type-code query', () => {
    const result = parseAircraftIdentity({ atcId: 'N738', atcModel: 'B738', title: '' })
    expect(result.icaoType).toBe('B738')
    expect(result.icaoTypeAmbiguous).toBe(false)
  })
})
