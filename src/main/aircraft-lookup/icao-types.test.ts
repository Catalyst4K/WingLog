import { describe, expect, it } from 'vitest'
import { getWakeCategory, loadTypes, searchAircraftTypes, searchTypes } from './icao-types'

// A handful of rows in the real resources/icao-aircraft-types.csv shape, not the full
// 7389-row file — keeps these tests fast and focused on the search logic itself. Model
// names are hyphenated right after the letter prefix ("A-350-1000 XWB"), matching the
// real file exactly — not "A350-1000", which would (wrongly) already match a plain
// substring search for "A350" and hide the real bug this shape causes.
const FIXTURE_CSV = `manufacturer,model,type_designator,description,engine_type,engine_count,wtc
AIRBUS,A-350-1000 XWB,A35K,LandPlane,Jet,2,H
Boeing,777-300ER,B77W,LandPlane,Jet,2,H
Boeing,737-800,B738,LandPlane,Jet,2,M
Cessna,172 Skyhawk,C172,LandPlane,Piston,1,L`

describe('loadTypes', () => {
  it('parses manufacturer/model/type_designator/wtc from real-shaped CSV rows', () => {
    const types = loadTypes(FIXTURE_CSV)
    expect(types).toEqual([
      { manufacturer: 'AIRBUS', model: 'A-350-1000 XWB', icaoType: 'A35K', wakeCat: 'H' },
      { manufacturer: 'Boeing', model: '777-300ER', icaoType: 'B77W', wakeCat: 'H' },
      { manufacturer: 'Boeing', model: '737-800', icaoType: 'B738', wakeCat: 'M' },
      { manufacturer: 'Cessna', model: '172 Skyhawk', icaoType: 'C172', wakeCat: 'L' }
    ])
  })
})

describe('searchTypes', () => {
  const types = loadTypes(FIXTURE_CSV)

  it('matches by manufacturer, model, or ICAO type code, case-insensitively', () => {
    expect(searchTypes(types, 'airbus')).toEqual([types[0]])
    expect(searchTypes(types, '777')).toEqual([types[1]])
    expect(searchTypes(types, 'b738')).toEqual([types[2]])
  })

  it('matches "A350" against the real hyphenated model shape "A-350-1000 XWB"', () => {
    // The real vendored file hyphenates right after the letter prefix, which a plain
    // (non-normalizing) substring search for the obvious "A350" would miss entirely.
    expect(searchTypes(types, 'A350')).toEqual([types[0]])
    expect(searchTypes(types, 'a-350')).toEqual([types[0]])
  })

  it('returns nothing for a query under 2 characters, to avoid matching everything', () => {
    expect(searchTypes(types, 'b')).toEqual([])
    expect(searchTypes(types, '')).toEqual([])
  })

  it('returns multiple matches when more than one row matches', () => {
    expect(searchTypes(types, 'boeing')).toEqual([types[1], types[2]])
  })

  it('returns nothing for a query that matches no row', () => {
    expect(searchTypes(types, 'concorde')).toEqual([])
  })
})

describe('searchAircraftTypes (real vendored data)', () => {
  it('finds the real A350 by its ICAO type code', () => {
    const results = searchAircraftTypes('A35K')
    expect(results.some((r) => r.icaoType === 'A35K')).toBe(true)
  })

  it('finds the real A350 by the obvious un-hyphenated search "A350"', () => {
    const results = searchAircraftTypes('A350')
    expect(results.some((r) => r.icaoType === 'A35K')).toBe(true)
  })

  it('finds real Boeing types by manufacturer name', () => {
    const results = searchAircraftTypes('boeing')
    expect(results.length).toBeGreaterThan(0)
    expect(results.every((r) => r.manufacturer.toLowerCase().includes('boeing'))).toBe(true)
  })
})

describe('getWakeCategory (real vendored data, docs/decisions.md 2026-09-12)', () => {
  it('resolves L for a real light GA type', () => {
    expect(getWakeCategory('C172')).toBe('L')
  })

  it('resolves M for real narrowbody types', () => {
    expect(getWakeCategory('A320')).toBe('M')
    expect(getWakeCategory('B738')).toBe('M')
  })

  it('resolves H for real widebody types', () => {
    expect(getWakeCategory('A35K')).toBe('H')
    expect(getWakeCategory('B77W')).toBe('H')
  })

  it('resolves J for the real super category (A380)', () => {
    expect(getWakeCategory('A388')).toBe('J')
  })

  it('is case-insensitive', () => {
    expect(getWakeCategory('c172')).toBe('L')
  })

  it('returns null for a type not in the vendored data', () => {
    expect(getWakeCategory('NOTATYPE')).toBeNull()
  })

  it('returns null for a real type whose only wtc value is ambiguous ("L/M"), rather than guessing', () => {
    expect(getWakeCategory('B350')).toBeNull()
  })
})
