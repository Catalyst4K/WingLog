import { describe, expect, it } from 'vitest'
import type { BeyondAtcFrequencyOption } from './types/beyondatc'
import {
  groupFrequencies,
  normaliseFrequency,
  openingAirport,
  runwaysFromStationName,
  stationDisplayName
} from './beyondatc-frequencies'

// The real list from flight 236 (EGLL-WSSS, 2026-10-12), shortened: airports, types and names as BeyondATC sent them, runways empty.
const option = (
  airport: string,
  type: string,
  frequency: string,
  name: string,
  airportName = ''
): BeyondAtcFrequencyOption => ({ airport, airportName, frequency, name, type, stationType: '', runways: '' })
const LIST: BeyondAtcFrequencyOption[] = [
  option('EGLL', 'Approach', '119.730', 'HEATHROW DIRECTOR', 'Heathrow'),
  option('EGLL', 'Departure', '134.125', 'LONDON CONTROL', 'Heathrow'),
  option('EGLL', 'Tower', '118.705', 'HEATHROW TOWER', 'Heathrow'),
  option('EGLL', 'Ground', '121.705', 'HEATHROW GROUND', 'Heathrow'),
  option('EGLL', 'Clearance', '121.980', 'HEATHROW DELIVERY', 'Heathrow'),
  option('EGLL', 'ATIS', '128.080', 'HEATHROW INFO', 'Heathrow'),
  option('', 'Center', '120.530', 'London Control'),
  option('WSSS', 'Tower', '118.250', 'SINGAPORE TOWER', 'Changi'),
  option('WSSS', 'Tower', '118.600', 'SINGAPORE TOWER', 'Changi'),
  option('WSSS', 'ATIS', '128.600', 'WSSS', 'Changi')
]

describe('normaliseFrequency', () => {
  it('makes 133.9 and 133.900 the same station, and leaves non-numbers alone', () => {
    expect(normaliseFrequency('133.9')).toBe('133.900')
    expect(normaliseFrequency(' 121.5 ')).toBe('121.500')
    expect(normaliseFrequency('')).toBe('')
    expect(normaliseFrequency('Radio Off')).toBe('Radio Off')
  })
})

describe('runwaysFromStationName', () => {
  it('reads the runways BeyondATC puts in a tuned station name', () => {
    expect(runwaysFromStationName('Heathrow Ground (09R)')).toBe('09R')
    expect(runwaysFromStationName('Singapore Approach (20R, 20C)')).toBe('20R, 20C')
    expect(runwaysFromStationName('Kolkata (Bhubaneshwar) Control')).toBe('')
    expect(runwaysFromStationName('Singapore Tower')).toBe('')
  })

  it('does not take other brackets for runways', () => {
    expect(runwaysFromStationName('Kolkata Control (Raipur)')).toBe('')
    expect(runwaysFromStationName('Heathrow Tower (09R, North)')).toBe('')
  })
})

describe('stationDisplayName', () => {
  it('title-cases capitals, and keeps codes and mixed-case names as they are', () => {
    expect(stationDisplayName('SINGAPORE APPROACH')).toBe('Singapore Approach')
    expect(stationDisplayName('WSSS')).toBe('WSSS')
    expect(stationDisplayName('London Control')).toBe('London Control')
    expect(stationDisplayName('  HEATHROW INFO ')).toBe('Heathrow Info')
  })
})

describe('groupFrequencies', () => {
  const grouped = groupFrequencies(LIST)

  it('puts each airport together, in the order they appear, and the en-route entries last', () => {
    expect(grouped.map((a) => a.airport)).toEqual(['EGLL', 'WSSS', ''])
    expect(grouped[0].airportName).toBe('Heathrow')
  })

  it('orders the types the way a flight uses them: delivery, ground, tower, departure, approach, ATIS', () => {
    expect(grouped[0].groups.map((g) => g.type)).toEqual([
      'Clearance',
      'Ground',
      'Tower',
      'Departure',
      'Approach',
      'ATIS'
    ])
  })

  it('keeps several stations of one type together, in BeyondATC order', () => {
    const wsssTower = grouped[1].groups.find((g) => g.type === 'Tower')
    expect(wsssTower?.stations.map((s) => s.frequency)).toEqual(['118.250', '118.600'])
  })

  it('puts an unknown type after the known ones', () => {
    const odd = groupFrequencies([
      option('EGLL', 'Mystery', '120.000', 'X'),
      option('EGLL', 'Tower', '118.705', 'T')
    ])
    expect(odd[0].groups.map((g) => g.type)).toEqual(['Tower', 'Mystery'])
  })

  it('is empty for no list', () => {
    expect(groupFrequencies([])).toEqual([])
  })
})

describe('openingAirport', () => {
  it('opens on the departure in the first half of the flight, and the arrival after', () => {
    expect(openingAirport(null)).toBe('departure')
    expect(openingAirport(0)).toBe('departure')
    expect(openingAirport(49.9)).toBe('departure')
    expect(openingAirport(50)).toBe('arrival')
    expect(openingAirport(98.1)).toBe('arrival')
  })
})
