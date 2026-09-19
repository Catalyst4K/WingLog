import { describe, expect, it } from 'vitest'
import type { Airfield, TrackPoint } from '@shared/ipc'
import {
  airfieldFeatureCollection,
  bearingDeg,
  circleCoordinates,
  destinationLonLat,
  formatNearest,
  haversineNm,
  nearestAirfield,
  RANGE_RING_RADII_NM,
  rangeRingFeatures,
  recentTrailSegments
} from './vfr'

function airfield(
  icao: string,
  type: Airfield['type'],
  latitude: number,
  longitude: number,
  name = ''
): Airfield {
  return { icao, name, type, latitude, longitude }
}

function point(minutesFromStart: number, lon: number, resumeSegment = 0): TrackPoint {
  return {
    tsUtc: new Date(Date.UTC(2026, 8, 18, 12, minutesFromStart)).toISOString(),
    latitude: 51,
    longitude: lon,
    resumeSegment
  } as TrackPoint
}

describe('great-circle helpers', () => {
  it('measures a degree of latitude as 60 nm, and London to Paris at ~188 nm', () => {
    expect(haversineNm(51, 0, 52, 0)).toBeCloseTo(60.04, 1)
    // EGLL (51.4706, -0.4619) to LFPG (49.0097, 2.5479): ~ 188 nm (well-known ~347 km).
    expect(haversineNm(51.4706, -0.4619, 49.0097, 2.5479)).toBeCloseTo(187.6, 0)
  })

  it('gives cardinal bearings and wraps into 0..360', () => {
    expect(bearingDeg(0, 0, 1, 0)).toBeCloseTo(0, 5)
    expect(bearingDeg(0, 0, 0, 1)).toBeCloseTo(90, 5)
    expect(bearingDeg(0, 0, -1, 0)).toBeCloseTo(180, 5)
    expect(bearingDeg(0, 0, 0, -1)).toBeCloseTo(270, 5)
  })

  it('places a destination the right distance away on the right bearing (round trip)', () => {
    const [lon, lat] = destinationLonLat(51.5, -0.5, 135, 20)
    expect(haversineNm(51.5, -0.5, lat, lon)).toBeCloseTo(20, 3)
    expect(bearingDeg(51.5, -0.5, lat, lon)).toBeCloseTo(135, 1)
  })
})

describe('range rings', () => {
  it('draws a closed circle whose every vertex is the radius from the centre', () => {
    const ring = circleCoordinates(51.5, -0.5, 10)
    expect(ring[0]).toEqual(ring[ring.length - 1])
    for (const [lon, lat] of ring) expect(haversineNm(51.5, -0.5, lat, lon)).toBeCloseTo(10, 3)
  })

  it('has one ring line and one label per radius, labelled at the northern edge', () => {
    const fc = rangeRingFeatures({ latitude: 40, longitude: -100 })
    const lines = fc.features.filter((f) => f.geometry.type === 'LineString')
    const labels = fc.features.filter((f) => f.geometry.type === 'Point')
    expect(lines.map((f) => f.properties.radiusNm)).toEqual([...RANGE_RING_RADII_NM])
    expect(labels.map((f) => (f.properties as { label: string }).label)).toEqual(['5 nm', '10 nm', '20 nm'])
    const north = labels[0]!.geometry.coordinates as [number, number]
    expect(north[0]).toBeCloseTo(-100, 5)
    expect(north[1]).toBeGreaterThan(40)
  })

  it('draws nothing without a position, and stays continuous across the antimeridian', () => {
    expect(rangeRingFeatures(null).features).toEqual([])
    const ring = circleCoordinates(-17, 179.95, 20)
    const lons = ring.map(([lon]) => lon)
    // Unwrapped: goes past 180 instead of jumping to -180.
    expect(Math.max(...lons)).toBeGreaterThan(180)
    for (let i = 1; i < lons.length; i++) expect(Math.abs(lons[i]! - lons[i - 1]!)).toBeLessThan(1)
  })
})

describe('recentTrailSegments', () => {
  it('keeps only the last 10 minutes measured from the newest point, not the wall clock', () => {
    const points = [0, 5, 12, 18, 25].map((m, i) => point(m, i))
    // Newest is minute 25 -> cutoff minute 15: minutes 18 and 25 remain.
    expect(recentTrailSegments(points)).toEqual([
      [
        [3, 51],
        [4, 51]
      ]
    ])
  })

  it('splits at a resume gap so a restart is not joined by a straight line', () => {
    const points = [point(20, 0, 0), point(21, 1, 0), point(22, 2, 1), point(23, 3, 1)]
    expect(recentTrailSegments(points)).toHaveLength(2)
  })

  it('returns nothing for no points, a lone point, or an unreadable timestamp', () => {
    expect(recentTrailSegments([])).toEqual([])
    expect(recentTrailSegments([point(1, 0)])).toEqual([])
    expect(recentTrailSegments([{ ...point(1, 0), tsUtc: 'garbage' }])).toEqual([])
  })

  it('honours a custom window', () => {
    const points = [point(0, 0), point(1, 1), point(2, 2), point(3, 3)]
    expect(recentTrailSegments(points, 1)[0]).toHaveLength(2)
  })
})

describe('nearestAirfield', () => {
  const fields = [
    airfield('EGLL', 'large_airport', 51.4706, -0.4619, 'Heathrow'),
    airfield('EGLF', 'medium_airport', 51.2758, -0.7763, 'Farnborough'),
    airfield('EGLW', 'heliport', 51.4697, -0.1791, 'London Heliport'),
    airfield('EGKB', 'small_airport', 51.3308, 0.0325, 'Biggin Hill'),
    airfield('EGSS', 'seaplane_base', 51.9, 0.2)
  ]

  it('finds the nearest landable airfield with exact distance and bearing', () => {
    // Over Kew: Heathrow is nearest (west-south-west), not the nearer heliport.
    const result = nearestAirfield(51.4787, -0.2956, fields)
    expect(result?.airfield.icao).toBe('EGLL')
    expect(result?.distanceNm).toBeCloseTo(haversineNm(51.4787, -0.2956, 51.4706, -0.4619), 6)
    expect(result?.bearingDeg).toBeGreaterThan(260)
    expect(result?.bearingDeg).toBeLessThan(280)
  })

  it('ignores heliports and seaplane bases, and returns null when nothing qualifies', () => {
    expect(nearestAirfield(51.4697, -0.1791, fields)?.airfield.icao).not.toBe('EGLW')
    expect(nearestAirfield(51.9, 0.2, [airfield('EGLW', 'heliport', 51.9, 0.2)])).toBeNull()
    expect(nearestAirfield(0, 0, [])).toBeNull()
  })

  it('finds a neighbour across the antimeridian', () => {
    const fiji = [
      airfield('NFFN', 'large_airport', -17.75, 177.45),
      airfield('NFNA', 'medium_airport', -18.04, -178.5)
    ]
    expect(nearestAirfield(-18.0, 179.9, fiji)?.airfield.icao).toBe('NFNA')
  })
})

describe('formatNearest', () => {
  const result = (
    distanceNm: number,
    brg: number,
    name = 'Heathrow'
  ): Parameters<typeof formatNearest>[0] => ({
    airfield: airfield('EGLL', 'large_airport', 0, 0, name),
    distanceNm,
    bearingDeg: brg
  })

  it('shows one decimal under 10 nm and whole numbers above, with a zero-padded bearing', () => {
    expect(formatNearest(result(7.26, 45))).toBe('EGLL Heathrow · 7.3 nm · 045°')
    expect(formatNearest(result(12.6, 270))).toBe('EGLL Heathrow · 13 nm · 270°')
  })

  it('omits a missing name and reads 360 as 000', () => {
    expect(formatNearest(result(3, 359.9, ''))).toBe('EGLL · 3.0 nm · 000°')
  })
})

describe('airfieldFeatureCollection', () => {
  it('emits [lon, lat] points carrying only what the layers use', () => {
    const fc = airfieldFeatureCollection([airfield('EGLL', 'large_airport', 51.47, -0.46, 'Heathrow')])
    expect(fc.features[0]).toEqual({
      type: 'Feature',
      properties: { icao: 'EGLL', name: 'Heathrow', type: 'large_airport' },
      geometry: { type: 'Point', coordinates: [-0.46, 51.47] }
    })
  })
})
