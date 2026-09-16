import { describe, expect, it } from 'vitest'
import {
  getAirportCoords,
  greatCircleDistanceNm,
  greatCircleWaypoints,
  loadAirportCoords,
  loadAirportLocations,
  loadAirports,
  nearestAirport,
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

describe('greatCircleWaypoints (real vendored data)', () => {
  it('returns null when either airport is not in the vendored list', () => {
    expect(greatCircleWaypoints('ZZZZ', 'VHHH')).toBeNull()
    expect(greatCircleWaypoints('EGLL', 'ZZZZ')).toBeNull()
  })

  it('starts and ends at the two airports, with the requested number of points', () => {
    const points = greatCircleWaypoints('EGLL', 'KJFK', 10)
    const dep = getAirportCoords('EGLL')
    const arr = getAirportCoords('KJFK')
    expect(points).toHaveLength(10)
    expect(points?.[0][0]).toBeCloseTo(dep!.lon, 5)
    expect(points?.[0][1]).toBeCloseTo(dep!.lat, 5)
    expect(points?.[9][0]).toBeCloseTo(arr!.lon, 5)
    expect(points?.[9][1]).toBeCloseTo(arr!.lat, 5)
  })

  it('curves toward the pole on a long-haul route, unlike a naive straight-line midpoint', () => {
    // EGLL (London) <-> VHHH (Hong Kong): a real great circle between two northern-
    // hemisphere points this far apart bows noticeably further north than a naive lat/lon
    // lerp between the two endpoints — the actual point of doing spherical interpolation
    // (a slerp through 3D Cartesian space) instead of a 2-point Mercator line.
    const dep = getAirportCoords('EGLL')!
    const arr = getAirportCoords('VHHH')!
    const naiveMidLat = (dep.lat + arr.lat) / 2

    const points = greatCircleWaypoints('EGLL', 'VHHH', 101)
    const midLat = points?.[50][1]
    expect(midLat).toBeGreaterThan(naiveMidLat + 5)
  })

  it('barely bows off a straight line for a short domestic pair', () => {
    // EGLL (London Heathrow) <-> EGCC (Manchester): short enough that the great-circle
    // midpoint should sit within a fraction of a degree of the naive lat/lon lerp, unlike
    // the long-haul case above.
    const dep = getAirportCoords('EGLL')!
    const arr = getAirportCoords('EGCC')!
    const naiveMidLat = (dep.lat + arr.lat) / 2
    const naiveMidLon = (dep.lon + arr.lon) / 2

    const points = greatCircleWaypoints('EGLL', 'EGCC', 11)
    const [midLon, midLat] = points![5]
    expect(midLat).toBeCloseTo(naiveMidLat, 1)
    expect(midLon).toBeCloseTo(naiveMidLon, 1)
  })

  it('returns a single coordinate, not NaN, for a same-airport pair', () => {
    const points = greatCircleWaypoints('EGLL', 'EGLL')
    expect(points).toEqual([[expect.any(Number), expect.any(Number)]])
    expect(points?.[0].every(Number.isFinite)).toBe(true)
  })
})

// Real, not synthetic: the old Kai Tak site (22.3157, 114.2036 — the real touchdown
// position from flight-captures/tier2-vfr-no-ofp-short-hop-*.ndjson, multiple-landings.md's
// own motivating flight). Checked live against the real vendored CSV 2026-09-16: unlike
// that plan doc's claim, there is no VHHX/"closed" row here at all — the two nearest rows
// are genuinely heliports (Wan Chai ~4.7km, Shun Tak ~6.4km), with the nearest real
// airfield (Shek Kong Air Base, medium_airport) at ~19km. That's exactly the case the
// heliport exclusion exists for, so it's used as the real-data regression instead of the
// undocumented Kai Tak row the plan assumed.
const OLD_KAI_TAK_SITE = { lat: 22.315718703486187, lon: 114.20363925721735 }

describe('nearestAirport (real vendored data)', () => {
  it('prefers a real airfield over a much closer heliport, when both are in range', () => {
    expect(nearestAirport(OLD_KAI_TAK_SITE.lat, OLD_KAI_TAK_SITE.lon, 15)).toBe('VHSK')
  })

  it('falls back to the heliport when nothing else is in range', () => {
    expect(nearestAirport(OLD_KAI_TAK_SITE.lat, OLD_KAI_TAK_SITE.lon, 5)).toBe('HK07')
  })

  it('returns null when nothing vendored is within range at all', () => {
    // The middle of the Pacific — nothing should be within 1nm.
    expect(nearestAirport(10, -160, 1)).toBeNull()
  })

  it('returns the exact airport for a position right on top of a well-known field', () => {
    const egll = getAirportCoords('EGLL')!
    expect(nearestAirport(egll.lat, egll.lon, 5)).toBe('EGLL')
  })
})

describe('loadAirportLocations', () => {
  const FIXTURE = `icao,name,municipality,iso_country,type,latitude_deg,longitude_deg
EGLL,London Heathrow Airport,London,GB,large_airport,51.4706,-0.461941
K00A,Total RF Heliport,Bensalem,US,heliport,40.070985,-74.933689
ZZZZ,No Coordinates Airport,Nowhere,ZZ,small_airport,,`

  it('parses lat/lon/type keyed by ICAO, skipping rows with no coordinates', () => {
    const locations = loadAirportLocations(FIXTURE)
    expect(locations.get('EGLL')).toEqual({ lat: 51.4706, lon: -0.461941, type: 'large_airport' })
    expect(locations.get('K00A')?.type).toBe('heliport')
    expect(locations.has('ZZZZ')).toBe(false)
  })
})
