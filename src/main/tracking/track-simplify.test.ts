import { describe, expect, it } from 'vitest'
import type { TrackPoint } from '@shared/ipc'
import { simplifyTrackPoints } from './track-simplify'

const BASE_TIME = new Date('2026-09-01T12:00:00Z').getTime()

function point(overrides: Partial<TrackPoint> & { id: number }): TrackPoint {
  return {
    flightId: 1,
    tsUtc: new Date(BASE_TIME + overrides.id * 1000).toISOString(),
    latitude: 51.4775,
    longitude: -0.4614,
    altitudeM: 10000,
    altitudeAglM: 10000,
    indicatedAirspeedMs: 230,
    machSpeed: 0.75,
    groundSpeedMs: 230,
    verticalSpeedMs: 0,
    headingTrueDeg: 90,
    pitchDeg: 2,
    bankDeg: 0,
    phase: 'cruise',
    onGround: false,
    fuelKg: 50000,
    gForce: 1,
    windSpeedMs: 0,
    windDirectionDeg: 0,
    ...overrides
  }
}

describe('simplifyTrackPoints', () => {
  it('returns the input unchanged for 2 or fewer points', () => {
    const points = [point({ id: 0 }), point({ id: 1 })]
    expect(simplifyTrackPoints(points)).toBe(points)
    expect(simplifyTrackPoints([point({ id: 0 })])).toHaveLength(1)
    expect(simplifyTrackPoints([])).toEqual([])
  })

  it('collapses a long straight, level, constant-speed cruise leg to a handful of points', () => {
    const points = Array.from({ length: 500 }, (_, i) =>
      point({
        id: i,
        // A straight line of constant heading — longitude advances steadily, latitude
        // barely at all, matching a real long cruise leg.
        latitude: 30 + i * 0.001,
        longitude: -20 + i * 0.02
      })
    )
    const result = simplifyTrackPoints(points)
    expect(result.length).toBeLessThan(10)
    // First and last always survive.
    expect(result[0]).toEqual(points[0])
    expect(result[result.length - 1]).toEqual(points[points.length - 1])
  })

  it('keeps a real turn even when altitude and speed never change', () => {
    const points: TrackPoint[] = []
    for (let i = 0; i < 40; i++) {
      points.push(point({ id: i, latitude: 30, longitude: -20 + i * 0.05 }))
    }
    // A sharp turn: latitude jumps well off the straight line the surrounding points
    // define, for one sample, then resumes straight.
    const turnIndex = 40
    points.push(point({ id: turnIndex, latitude: 31.5, longitude: -20 + turnIndex * 0.05 }))
    for (let i = 41; i < 80; i++) {
      points.push(point({ id: i, latitude: 30, longitude: -20 + i * 0.05 }))
    }

    const result = simplifyTrackPoints(points)
    expect(result.some((p) => p.latitude === 31.5)).toBe(true)
  })

  it('keeps a step climb even on an otherwise dead-straight route', () => {
    const points: TrackPoint[] = []
    for (let i = 0; i < 100; i++) {
      // Perfectly straight route (identical lat/lon delta each tick), constant speed —
      // only altitude changes, roughly halfway through.
      const altitudeM = i < 50 ? 9000 : 10500
      points.push(point({ id: i, latitude: 30, longitude: -20 + i * 0.02, altitudeM }))
    }

    const result = simplifyTrackPoints(points)
    expect(result.some((p) => p.altitudeM === 10500)).toBe(true)
    // The climb itself (somewhere around index 50) should be represented, not just the
    // endpoints of the whole flat-route line.
    expect(result.length).toBeGreaterThan(2)
  })

  it('keeps a speed change even on an otherwise dead-straight, level route', () => {
    const points: TrackPoint[] = []
    for (let i = 0; i < 100; i++) {
      const indicatedAirspeedMs = i < 50 ? 230 : 140 // e.g. slowing for descent/approach
      points.push(point({ id: i, latitude: 30, longitude: -20 + i * 0.02, indicatedAirspeedMs }))
    }

    const result = simplifyTrackPoints(points)
    expect(result.some((p) => p.indicatedAirspeedMs === 140)).toBe(true)
  })

  it('preserves original point order', () => {
    const points = Array.from({ length: 200 }, (_, i) =>
      point({ id: i, latitude: 30 + Math.sin(i / 10), longitude: -20 + i * 0.02 })
    )
    const result = simplifyTrackPoints(points)
    const ids = result.map((p) => new Date(p.tsUtc).getTime())
    const sortedIds = [...ids].sort((a, b) => a - b)
    expect(ids).toEqual(sortedIds)
  })
})
