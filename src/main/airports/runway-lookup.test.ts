import { describe, expect, it } from 'vitest'
import { loadRunwayEnds, resolveAirportPosition, resolveRunwayEnd, type RunwayEnd } from './runway-lookup'

const FIXTURE: RunwayEnd[] = [
  // KLAX has real parallel runways at (nearly) the same heading — a good stand-in for
  // the parallel-runway case without needing the full real dataset.
  { icao: 'KLAX', ident: '25L', lat: 33.9425, lon: -118.4081, headingTrueDeg: 250 },
  { icao: 'KLAX', ident: '25R', lat: 33.9364, lon: -118.4081, headingTrueDeg: 250 },
  { icao: 'KLAX', ident: '07L', lat: 33.9364, lon: -118.3809, headingTrueDeg: 70 },
  { icao: 'EGLL', ident: '27L', lat: 51.4775, lon: -0.4614, headingTrueDeg: 270 }
]

describe('resolveRunwayEnd', () => {
  it('picks the runway end whose heading matches the touchdown heading', () => {
    const result = resolveRunwayEnd(FIXTURE, 'EGLL', 270, 51.4775, -0.4614)
    expect(result?.ident).toBe('27L')
  })

  it('never matches a different airport', () => {
    const result = resolveRunwayEnd(FIXTURE, 'KJFK', 270, 51.4775, -0.4614)
    expect(result).toBeNull()
  })

  it('rejects a heading more than the plausible tolerance away from any candidate', () => {
    // EGLL only has 27L (270) in the fixture — a touchdown heading of 090 is off by 180.
    const result = resolveRunwayEnd(FIXTURE, 'EGLL', 90, 51.4775, -0.4614)
    expect(result).toBeNull()
  })

  it('picks the nearer of two parallel runways with the same heading, by touchdown position', () => {
    // Touchdown position much closer to 25R's threshold than 25L's.
    const nearR = resolveRunwayEnd(FIXTURE, 'KLAX', 250, 33.9364, -118.4081)
    expect(nearR?.ident).toBe('25R')

    const nearL = resolveRunwayEnd(FIXTURE, 'KLAX', 250, 33.9425, -118.4081)
    expect(nearL?.ident).toBe('25L')
  })

  it('prefers a closer heading match over a closer position on a different runway', () => {
    // Touchdown near 25L/25R's longitude but heading matches 07L (reciprocal-ish area) —
    // heading dominates the score, so it should not pick a parallel runway just because
    // it's geographically nearer.
    const result = resolveRunwayEnd(FIXTURE, 'KLAX', 70, 33.9364, -118.3809)
    expect(result?.ident).toBe('07L')
  })

  // Real vendored data for VHHH: three roughly-parallel runways whose published headings
  // (OurAirports, integer-rounded) are 07C=71°, 07L=74°, 07R=71° — a real landing on 07L
  // was previously scored against 07C (overnight-test-findings.md #7) because heading
  // dominated the old scoring formula and 07C's heading (71) was closer to typical
  // touchdown headings than 07L's (74). Position must decide this, not heading.
  const VHHH: RunwayEnd[] = [
    { icao: 'VHHH', ident: '07C', lat: 22.3104, lon: 113.896004, headingTrueDeg: 71 },
    { icao: 'VHHH', ident: '07L', lat: 22.321074, lon: 113.880692, headingTrueDeg: 74 },
    { icao: 'VHHH', ident: '07R', lat: 22.2962, lon: 113.898003, headingTrueDeg: 71 }
  ]

  it.each([70, 71, 72, 73, 74])(
    'resolves a real touchdown on 07L\'s centreline to 07L, not the closer-heading 07C (touchdown heading %d)',
    (touchdownHeadingDeg) => {
      // 400m past 07L's threshold, exactly on its centreline.
      const headingRad = (74 * Math.PI) / 180
      const metersPerDegLat = 111_320
      const metersPerDegLon = metersPerDegLat * Math.cos((22.321074 * Math.PI) / 180)
      const northM = 400 * Math.cos(headingRad)
      const eastM = 400 * Math.sin(headingRad)
      const touchdownLat = 22.321074 + northM / metersPerDegLat
      const touchdownLon = 113.880692 + eastM / metersPerDegLon

      const result = resolveRunwayEnd(VHHH, 'VHHH', touchdownHeadingDeg, touchdownLat, touchdownLon)
      expect(result?.ident).toBe('07L')
    }
  )
})

describe('resolveAirportPosition', () => {
  it('averages every runway end for the airport, not just one', () => {
    // KLAX has three ends in the fixture, at three different lat/lons.
    const result = resolveAirportPosition(FIXTURE, 'KLAX')
    expect(result).toEqual({
      lat: (33.9425 + 33.9364 + 33.9364) / 3,
      lon: (-118.4081 + -118.4081 + -118.3809) / 3
    })
  })

  it('is case-insensitive on the ICAO', () => {
    expect(resolveAirportPosition(FIXTURE, 'egll')).toEqual({ lat: 51.4775, lon: -0.4614 })
  })

  it('returns null for an airport with no runway data at all', () => {
    expect(resolveAirportPosition(FIXTURE, 'ZZZZ')).toBeNull()
  })
})

describe('loadRunwayEnds', () => {
  it('parses a real-shaped CSV and skips rows with missing/non-numeric fields', () => {
    const csv = ['icao,ident,lat,lon,heading_true_deg', 'EGLL,27L,51.4775,-0.4614,270', 'EGLL,,,,', 'BAD,X,notanumber,0,0'].join(
      '\n'
    )
    const ends = loadRunwayEnds(csv)
    expect(ends).toEqual([{ icao: 'EGLL', ident: '27L', lat: 51.4775, lon: -0.4614, headingTrueDeg: 270 }])
  })
})
