import { describe, expect, it } from 'vitest'
import {
  aimingPointDistanceForLengthM,
  distanceFromUsableThresholdM,
  loadRunwayEnds,
  resolveAirportPosition,
  resolveRunwayEnd,
  resolveRunwayEndByIdent,
  toLandingRunway,
  type RunwayEnd
} from './runway-lookup'

/** Fills in Phase 1's real-geometry fields with "unknown" defaults so existing fixtures
 *  exercise the same fixed-fallback tolerances they always have — tests that care about
 *  the real per-runway width/length gating override them explicitly. */
function runwayEnd(fields: Pick<RunwayEnd, 'icao' | 'ident' | 'lat' | 'lon' | 'headingTrueDeg'> & Partial<RunwayEnd>): RunwayEnd {
  return {
    lengthM: null,
    widthM: null,
    displacedThresholdM: 0,
    elevationM: null,
    surface: null,
    aimingPointDistanceM: null,
    ...fields
  }
}

const FIXTURE: RunwayEnd[] = [
  // KLAX has real parallel runways at (nearly) the same heading — a good stand-in for
  // the parallel-runway case without needing the full real dataset.
  runwayEnd({ icao: 'KLAX', ident: '25L', lat: 33.9425, lon: -118.4081, headingTrueDeg: 250 }),
  runwayEnd({ icao: 'KLAX', ident: '25R', lat: 33.9364, lon: -118.4081, headingTrueDeg: 250 }),
  runwayEnd({ icao: 'KLAX', ident: '07L', lat: 33.9364, lon: -118.3809, headingTrueDeg: 70 }),
  runwayEnd({ icao: 'EGLL', ident: '27L', lat: 51.4775, lon: -0.4614, headingTrueDeg: 270 })
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
    runwayEnd({ icao: 'VHHH', ident: '07C', lat: 22.3104, lon: 113.896004, headingTrueDeg: 71 }),
    runwayEnd({ icao: 'VHHH', ident: '07L', lat: 22.321074, lon: 113.880692, headingTrueDeg: 74 }),
    runwayEnd({ icao: 'VHHH', ident: '07R', lat: 22.2962, lon: 113.898003, headingTrueDeg: 71 })
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

  it('uses a candidate\'s own real width for lateral tolerance instead of the fixed fallback', () => {
    // A narrow 30m-wide runway (half-width 15m + the 20m noise margin = 35m tolerance) —
    // 40m off centreline is outside that, even though it's well within the fixed 100m
    // fallback the old, width-unaware version of this check would have used.
    const narrow = [runwayEnd({ icao: 'EGLL', ident: '09', lat: 51.4775, lon: -0.4614, headingTrueDeg: 90, widthM: 30 })]
    const headingRad = (90 * Math.PI) / 180
    const metersPerDegLat = 111_320
    const metersPerDegLon = metersPerDegLat * Math.cos((51.4775 * Math.PI) / 180)
    // 40m north of the centreline, 200m down the runway.
    const alongM = 200
    const offsetM = 40
    const northM = alongM * Math.cos(headingRad) - offsetM * Math.sin(headingRad)
    const eastM = alongM * Math.sin(headingRad) + offsetM * Math.cos(headingRad)
    const touchdownLat = 51.4775 + northM / metersPerDegLat
    const touchdownLon = -0.4614 + eastM / metersPerDegLon

    expect(resolveRunwayEnd(narrow, 'EGLL', 90, touchdownLat, touchdownLon)).toBeNull()
  })

  it('uses a candidate\'s own real length for the along-track upper bound instead of the fixed fallback', () => {
    // A short 500m runway — a touchdown 1000m past the threshold is well within the fixed
    // 6000m fallback but past the end of this specific, short runway. Heading 90 (due
    // east): distanceFromThresholdM tracks purely eastward movement (positionRelativeTo-
    // Runway's own decomposition), so shift longitude, not latitude.
    const short = [runwayEnd({ icao: 'EGLC', ident: '09', lat: 51.5, lon: 0.05, headingTrueDeg: 90, lengthM: 500 })]
    const metersPerDegLon = 111_320 * Math.cos((51.5 * Math.PI) / 180)
    const touchdownLon = 0.05 + 1000 / metersPerDegLon
    expect(resolveRunwayEnd(short, 'EGLC', 90, 51.5, touchdownLon)).toBeNull()
  })
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
    expect(ends).toEqual([runwayEnd({ icao: 'EGLL', ident: '27L', lat: 51.4775, lon: -0.4614, headingTrueDeg: 270 })])
  })

  it('parses Phase 1\'s length/width/displaced-threshold/elevation/surface columns, converting feet to metres', () => {
    const header = 'icao,ident,lat,lon,heading_true_deg,length_ft,width_ft,displaced_threshold_ft,elevation_ft,surface'
    const row = 'VHHH,07L,22.321074,113.880692,74,13858,200,0,28,ASP'
    const [end] = loadRunwayEnds([header, row].join('\n'))
    expect(end).toMatchObject({
      lengthM: 13858 * 0.3048,
      widthM: 200 * 0.3048,
      displacedThresholdM: 0,
      elevationM: 28 * 0.3048,
      surface: 'ASP',
      // 13858ft ≈ 4223m, well over the 2400m band.
      aimingPointDistanceM: 400
    })
  })

  it('treats a blank Phase 1 column as unknown, not zero — except displaced-threshold, which defaults to zero', () => {
    const header = 'icao,ident,lat,lon,heading_true_deg,length_ft,width_ft,displaced_threshold_ft,elevation_ft,surface'
    const row = 'EGLL,27L,51.4775,-0.4614,270,,,,,'
    const [end] = loadRunwayEnds([header, row].join('\n'))
    expect(end).toMatchObject({
      lengthM: null,
      widthM: null,
      displacedThresholdM: 0,
      elevationM: null,
      surface: null,
      aimingPointDistanceM: null
    })
  })
})

describe('aimingPointDistanceForLengthM', () => {
  it('returns null when the length is unknown', () => {
    expect(aimingPointDistanceForLengthM(null)).toBeNull()
  })

  it.each([
    [500, 150],
    [799, 150],
    [800, 250],
    [1199, 250],
    [1200, 300],
    [2399, 300],
    [2400, 400],
    [4223, 400]
  ])('maps a %dm runway to %dm (ICAO Annex 14 §5.2.5)', (lengthM, expected) => {
    expect(aimingPointDistanceForLengthM(lengthM)).toBe(expected)
  })
})

describe('resolveRunwayEndByIdent', () => {
  it('finds the exact end by icao + ident', () => {
    const result = resolveRunwayEndByIdent(FIXTURE, 'KLAX', '25R')
    expect(result?.ident).toBe('25R')
  })

  it('is case-insensitive on the ICAO but exact on the ident', () => {
    expect(resolveRunwayEndByIdent(FIXTURE, 'klax', '25R')?.ident).toBe('25R')
    expect(resolveRunwayEndByIdent(FIXTURE, 'KLAX', '25r')).toBeNull()
  })

  it('returns null when no end matches', () => {
    expect(resolveRunwayEndByIdent(FIXTURE, 'KLAX', '09')).toBeNull()
    expect(resolveRunwayEndByIdent(FIXTURE, 'ZZZZ', '25R')).toBeNull()
  })
})

describe('toLandingRunway', () => {
  const complete = runwayEnd({
    icao: 'VHHH',
    ident: '07L',
    lat: 22.321074,
    lon: 113.880692,
    headingTrueDeg: 74,
    lengthM: 3800,
    widthM: 60,
    displacedThresholdM: 100,
    aimingPointDistanceM: 400
  })

  it('returns null for a null end', () => {
    expect(toLandingRunway(null)).toBeNull()
  })

  it('returns null when length is unknown', () => {
    expect(toLandingRunway({ ...complete, lengthM: null })).toBeNull()
  })

  it('returns null when width is unknown', () => {
    expect(toLandingRunway({ ...complete, widthM: null })).toBeNull()
  })

  it('returns null when the aiming-point distance is unknown', () => {
    expect(toLandingRunway({ ...complete, aimingPointDistanceM: null })).toBeNull()
  })

  it('shapes a complete end into the diagram-facing shape', () => {
    expect(toLandingRunway(complete)).toEqual({
      ident: '07L',
      lengthM: 3800,
      widthM: 60,
      displacedThresholdM: 100,
      aimingPointDistanceM: 400
    })
  })
})

describe('distanceFromUsableThresholdM', () => {
  it('subtracts the displacement from the raw physical-end distance', () => {
    const end = runwayEnd({ icao: 'X', ident: '09', lat: 0, lon: 0, headingTrueDeg: 90, displacedThresholdM: 100 })
    expect(distanceFromUsableThresholdM({ distanceFromThresholdM: 350, centrelineOffsetM: 0 }, end)).toBe(250)
  })

  it('is a no-op when the runway has no displacement', () => {
    const end = runwayEnd({ icao: 'X', ident: '09', lat: 0, lon: 0, headingTrueDeg: 90 })
    expect(distanceFromUsableThresholdM({ distanceFromThresholdM: 350, centrelineOffsetM: 0 }, end)).toBe(350)
  })
})
