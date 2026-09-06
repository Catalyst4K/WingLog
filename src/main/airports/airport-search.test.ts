import { describe, expect, it } from 'vitest'
import {
  getAirportCoords,
  greatCircleDistanceNm,
  loadAirportCoords,
  loadAirports,
  searchAirportList,
  searchAirports
} from './airport-search'

// Shaped like the real trimmed resources/airports.csv — including the two edge cases
// that motivated csv.ts's quote-aware parser and the icao_code/gps_code fallback: a
// quoted name containing a comma, and a row with no icao_code but a 4-letter gps_code.
const FIXTURE_CSV = `icao,name,municipality,iso_country,type
EGLL,London Heathrow Airport,London,GB,large_airport
KJFK,"John F. Kennedy, International Airport",New York,US,large_airport
K00A,Total RF Heliport,Bensalem,US,heliport
LFPG,Charles de Gaulle Airport,Paris,FR,large_airport`

// Real coordinates (EGLL/KJFK/VHHH) — includes latitude_deg/longitude_deg, the columns
// loadAirports above doesn't read but loadAirportCoords does.
const COORDS_FIXTURE_CSV = `icao,name,municipality,iso_country,type,latitude_deg,longitude_deg
EGLL,London Heathrow Airport,London,GB,large_airport,51.4706,-0.461941
KJFK,John F. Kennedy International Airport,New York,US,large_airport,40.639801,-73.7789
VHHH,Hong Kong International Airport,Hong Kong,HK,large_airport,22.31183,113.914772
ZZZZ,No Coordinates Airport,Nowhere,ZZ,small_airport,,`

describe('loadAirports', () => {
  it('parses icao/name/municipality/iso_country from real-shaped rows, including a quoted comma', () => {
    const airports = loadAirports(FIXTURE_CSV)
    expect(airports).toEqual([
      { icao: 'EGLL', name: 'London Heathrow Airport', municipality: 'London', isoCountry: 'GB' },
      {
        icao: 'KJFK',
        name: 'John F. Kennedy, International Airport',
        municipality: 'New York',
        isoCountry: 'US'
      },
      { icao: 'K00A', name: 'Total RF Heliport', municipality: 'Bensalem', isoCountry: 'US' },
      { icao: 'LFPG', name: 'Charles de Gaulle Airport', municipality: 'Paris', isoCountry: 'FR' }
    ])
  })
})

describe('searchAirportList', () => {
  const airports = loadAirports(FIXTURE_CSV)

  it('matches by ICAO code, name, or municipality, case-insensitively', () => {
    expect(searchAirportList(airports, 'egll')).toEqual([airports[0]])
    expect(searchAirportList(airports, 'heathrow')).toEqual([airports[0]])
    expect(searchAirportList(airports, 'paris')).toEqual([airports[3]])
  })

  it('matches a name containing a comma that survived quoted parsing', () => {
    expect(searchAirportList(airports, 'kennedy')).toEqual([airports[1]])
  })

  it('matches an ICAO code sourced from gps_code fallback (no icao_code in the original row)', () => {
    expect(searchAirportList(airports, 'K00A')).toEqual([airports[2]])
  })

  it('returns nothing for a query under 2 characters, to avoid matching everything', () => {
    expect(searchAirportList(airports, 'l')).toEqual([])
    expect(searchAirportList(airports, '')).toEqual([])
  })

  it('returns nothing for a query that matches no row', () => {
    expect(searchAirportList(airports, 'atlantis')).toEqual([])
  })
})

describe('searchAirports (real vendored data)', () => {
  it('finds a well-known airport by ICAO code', () => {
    const results = searchAirports('EGLL')
    expect(results.some((r) => r.icao === 'EGLL')).toBe(true)
  })

  it('finds a well-known airport by name', () => {
    const results = searchAirports('Heathrow')
    expect(results.some((r) => r.icao === 'EGLL')).toBe(true)
  })
})

describe('loadAirportCoords', () => {
  it('parses lat/lon keyed by ICAO', () => {
    const coords = loadAirportCoords(COORDS_FIXTURE_CSV)
    expect(coords.get('EGLL')).toEqual({ lat: 51.4706, lon: -0.461941 })
    expect(coords.get('VHHH')).toEqual({ lat: 22.31183, lon: 113.914772 })
  })

  it('skips a row with blank coordinates rather than storing NaN', () => {
    const coords = loadAirportCoords(COORDS_FIXTURE_CSV)
    expect(coords.has('ZZZZ')).toBe(false)
  })
})

describe('getAirportCoords / greatCircleDistanceNm (real vendored data)', () => {
  it('returns coordinates for a well-known airport', () => {
    const coords = getAirportCoords('EGLL')
    expect(coords).not.toBeNull()
    expect(coords?.lat).toBeCloseTo(51.47, 1)
  })

  it('returns null for an ICAO not in the vendored list', () => {
    expect(getAirportCoords('ZZZZ')).toBeNull()
  })

  it('computes a plausible great-circle distance for a known long-haul city pair', () => {
    // EGLL <-> VHHH is roughly 5,980 nm great-circle — just needs to be in the right
    // ballpark, not exact, to catch a gross unit/formula error.
    const nm = greatCircleDistanceNm('EGLL', 'VHHH')
    expect(nm).not.toBeNull()
    expect(nm as number).toBeGreaterThan(5000)
    expect(nm as number).toBeLessThan(7000)
  })

  it('returns null when either airport is not in the vendored list', () => {
    expect(greatCircleDistanceNm('ZZZZ', 'VHHH')).toBeNull()
    expect(greatCircleDistanceNm('EGLL', 'ZZZZ')).toBeNull()
  })
})
