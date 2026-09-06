import { describe, expect, it } from 'vitest'
import type { TrackPoint } from '@shared/ipc'
import { deriveFlownRouteJson, simplifyRoute } from './route-simplify'

function point(latitude: number, longitude: number): { latitude: number; longitude: number } {
  return { latitude, longitude }
}

describe('simplifyRoute', () => {
  it('collapses a straight line to its two endpoints', () => {
    const points = Array.from({ length: 20 }, (_, i) => point(51.5, -0.5 + i * 0.001))
    const result = simplifyRoute(points, 100)
    expect(result).toEqual([points[0], points[points.length - 1]])
  })

  it('keeps a point that deviates beyond the tolerance (a real turn)', () => {
    // A sharp turn well beyond 100m off the straight line between the endpoints.
    const points = [point(51.5, -0.5), point(51.55, -0.4), point(51.5, -0.3)]
    const result = simplifyRoute(points, 100)
    expect(result).toHaveLength(3)
  })

  it('drops a point that deviates less than the tolerance', () => {
    // A near-straight line with a tiny wobble, well under 100m.
    const points = [point(51.5, -0.5), point(51.50001, -0.4), point(51.5, -0.3)]
    const result = simplifyRoute(points, 100)
    expect(result).toEqual([points[0], points[2]])
  })

  it('returns points unchanged when fewer than 3 are given', () => {
    const points = [point(51.5, -0.5), point(51.6, -0.4)]
    expect(simplifyRoute(points, 100)).toEqual(points)
    expect(simplifyRoute([], 100)).toEqual([])
  })
})

function trackPoint(latitude: number, longitude: number): TrackPoint {
  return {
    id: 0,
    flightId: 1,
    tsUtc: '2026-09-04T00:00:00Z',
    latitude,
    longitude,
    altitudeM: 0,
    altitudeAglM: 0,
    indicatedAirspeedMs: 0,
    machSpeed: 0,
    groundSpeedMs: 0,
    verticalSpeedMs: 0,
    headingTrueDeg: 0,
    pitchDeg: 0,
    bankDeg: 0,
    phase: 'cruise',
    onGround: false,
    fuelKg: 0,
    gForce: 1,
    windSpeedMs: 0,
    windDirectionDeg: 0
  }
}

describe('deriveFlownRouteJson', () => {
  it('returns null for fewer than 2 points', () => {
    expect(deriveFlownRouteJson([])).toBeNull()
    expect(deriveFlownRouteJson([trackPoint(51.5, -0.5)])).toBeNull()
  })

  it('returns a JSON array of lat/lon pairs, simplified', () => {
    const points = Array.from({ length: 10 }, (_, i) => trackPoint(51.5, -0.5 + i * 0.001))
    const json = deriveFlownRouteJson(points)
    expect(json).not.toBeNull()
    const parsed = JSON.parse(json as string)
    expect(parsed).toEqual([
      { latitude: 51.5, longitude: -0.5 },
      { latitude: 51.5, longitude: -0.5 + 9 * 0.001 }
    ])
  })
})
