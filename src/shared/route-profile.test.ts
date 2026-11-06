import { describe, expect, it } from 'vitest'
import type { Waypoint } from './route'
import { distanceAlongRoute, routeProfile } from './route-profile'

function waypoint(ident: string, lon: number, altitudeFt: number, extra: Partial<Waypoint> = {}): Waypoint {
  return { ident, lon, lat: 0, altitudeFt, segment: 'enroute', ...extra }
}

/** One degree of longitude on the equator is 60 nautical miles, near enough. */
const DEGREE_NM = 60.04

describe('routeProfile', () => {
  it('puts each fix with a planned altitude at its distance along the route', () => {
    const profile = routeProfile([
      waypoint('EGLL', 0, 83),
      waypoint('LAM', 1, 9000),
      waypoint('TOC', 3, 35000),
      waypoint('JFK', 6, 13)
    ])
    expect(profile?.points.map((p) => [p.ident, p.altitudeFt])).toEqual([
      ['EGLL', 83],
      ['LAM', 9000],
      ['TOC', 35000],
      ['JFK', 13]
    ])
    expect(profile?.points.map((p) => Math.round(p.distanceNm))).toEqual([0, 60, 180, 360])
    expect(profile?.totalNm).toBeCloseTo(6 * DEGREE_NM, 0)
    expect(profile?.maxAltitudeFt).toBe(35000)
  })

  it('leaves a middle fix with no altitude out of the line, and stands the two ends on the ground', () => {
    const profile = routeProfile([
      waypoint('A', 0, 0),
      waypoint('NAV', 1, 0),
      waypoint('TOC', 2, 30000),
      waypoint('B', 4, 0)
    ])
    expect(profile?.points.map((p) => [p.ident, p.altitudeFt])).toEqual([
      ['A', 0],
      ['TOC', 30000],
      ['B', 0]
    ])
    // The fix left out still counts towards the distance.
    expect(profile?.points[1]?.distanceNm).toBeCloseTo(2 * DEGREE_NM, 0)
  })

  it('leaves the points along the departure runway out, but counts their distance', () => {
    const runway = (lon: number): Waypoint => waypoint('', lon, 0, { runwayPoint: true })
    const profile = routeProfile([runway(0), runway(0.05), waypoint('DET', 0.5, 4000), waypoint('B', 2, 30)])
    expect(profile?.points.map((p) => p.ident)).toEqual(['DET', 'B'])
    expect(profile?.points[0]?.distanceNm).toBeCloseTo(0.5 * DEGREE_NM, 0)
  })

  it('is null for a route too short to draw', () => {
    expect(routeProfile([])).toBeNull()
    expect(routeProfile([waypoint('A', 0, 100)])).toBeNull()
    // Two points but only one with an altitude and neither at an end.
    expect(
      routeProfile([waypoint('A', 0, 0, { runwayPoint: true }), waypoint('B', 1, 0, { runwayPoint: true })])
    ).toBeNull()
  })
})

describe('distanceAlongRoute', () => {
  const route = [waypoint('A', 0, 0), waypoint('B', 1, 5000), waypoint('C', 3, 0)]
  const cumulative = routeProfile(route)!.cumulativeNm

  it('is the distance of the nearest waypoint', () => {
    expect(distanceAlongRoute(route, cumulative, [0.9, 0])).toBeCloseTo(DEGREE_NM, 0)
    expect(distanceAlongRoute(route, cumulative, [2.8, 0.1])).toBeCloseTo(3 * DEGREE_NM, 0)
    expect(distanceAlongRoute(route, cumulative, [-1, 0])).toBe(0)
  })

  it('is null with no waypoints', () => {
    expect(distanceAlongRoute([], [], [0, 0])).toBeNull()
  })
})
