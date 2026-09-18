import { describe, expect, it } from 'vitest'
import type { Aircraft, NewAircraft } from '@shared/ipc'
import { parseAircraftInput } from './aircraft-validation'
import { parseAircraftRecords, serializeAircraft, toAircraftExportRecord } from './aircraft-portable'

const FLEET: NewAircraft[] = [
  {
    registration: 'G-XWBA',
    icaoType: 'A35K',
    operator: 'British Airways',
    operatorIata: 'BA',
    operatorIcao: 'BAW',
    simbriefAirframeId: null,
    simbriefType: null,
    currentIcao: 'EGLL'
  },
  {
    registration: 'N172SP',
    icaoType: 'C172',
    operator: 'Smith, "Bob" & Sons',
    operatorIata: null,
    operatorIcao: null,
    simbriefAirframeId: null,
    simbriefType: null,
    currentIcao: null
  }
]

describe('toAircraftExportRecord', () => {
  it('carries the identity fields only — no id, createdAt or photo', () => {
    const aircraft = { id: 9, createdAt: 'x', photoThumbnailUrl: 'u', ...FLEET[0] } as unknown as Aircraft
    expect(toAircraftExportRecord(aircraft)).toEqual(FLEET[0])
  })
})

describe('serializeAircraft / parseAircraftRecords', () => {
  it('writes a CSV with one column per exported field, quoting where needed', () => {
    const lines = serializeAircraft(FLEET, 'csv').trimEnd().split('\r\n')
    expect(lines[0]).toBe('registration,icaoType,operator,operatorIata,operatorIcao,simbriefAirframeId,simbriefType,currentIcao')
    expect(lines[1]).toBe('G-XWBA,A35K,British Airways,BA,BAW,,,EGLL')
    expect(lines[2]).toBe('N172SP,C172,"Smith, ""Bob"" & Sons",,,,,')
  })

  it('round-trips through the shared validator in both formats, blank cells becoming cleared fields', () => {
    for (const format of ['csv', 'json'] as const) {
      const parsed = parseAircraftRecords(serializeAircraft(FLEET, format), format).map((r) => parseAircraftInput(r))
      expect(parsed.map((p) => ('data' in p ? p.data : p))).toEqual(FLEET)
    }
  })

  it('accepts a single JSON object as well as an array, and ignores unknown CSV columns', () => {
    expect(parseAircraftRecords('{"registration":"G-A","icaoType":"A320"}', 'json')).toEqual([
      { registration: 'G-A', icaoType: 'A320' }
    ])
    expect(parseAircraftRecords('registration,icaoType,surprise\r\nG-A,A320,x\r\n', 'csv')).toEqual([
      { registration: 'G-A', icaoType: 'A320' }
    ])
  })

  it('matches CSV headers case-insensitively', () => {
    expect(parseAircraftRecords('Registration,ICAOTYPE\r\nG-A,A320\r\n', 'csv')).toEqual([
      { registration: 'G-A', icaoType: 'A320' }
    ])
  })

  it('throws for a document that is not usable at all, but leaves bad rows to the validator', () => {
    expect(() => parseAircraftRecords('', 'csv')).toThrow('empty')
    expect(() => parseAircraftRecords('nope', 'json')).toThrow()
    const [row] = parseAircraftRecords('registration,icaoType\r\n,A320\r\n', 'csv')
    expect(parseAircraftInput(row)).toEqual({ error: '"registration" is required' })
  })
})
