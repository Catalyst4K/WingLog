import { describe, expect, it } from 'vitest'
import { CLIMB_OUT_NM, FOLD_BACK_DEG, departureLine, type DepartureRunway } from './departure-line'

/** The great-circle distance between two [longitude, latitude] points, nautical miles. */
function distanceNm(a: [number, number], b: [number, number]): number {
  const rad = (degrees: number): number => (degrees * Math.PI) / 180
  const h =
    Math.sin(rad(b[1] - a[1]) / 2) ** 2 +
    Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(rad(b[0] - a[0]) / 2) ** 2
  return (2 * 6_371_000 * Math.asin(Math.sqrt(h))) / 1852
}
const at = (point: { lon: number; lat: number }): [number, number] => [point.lon, point.lat]

/** Runway 27, starting at the east end and running west, 3,000 m. */
const RUNWAY_27: DepartureRunway = {
  ident: '27',
  headingTrueDeg: 270,
  lengthM: 3000,
  thresholdLat: 51.5,
  thresholdLon: 0
}
const RUNWAY_NM = 3000 / 1852

describe('departureLine', () => {
  it('starts at the runway’s start and runs along the centreline to its far end, marked as the runway’s', () => {
    const points = departureLine(RUNWAY_27, [-0.5, 51.5])
    expect(points).toHaveLength(2)
    expect(points.every((p) => p.runwayPoint === true && p.segment === 'sid')).toBe(true)
    expect(points[0]).toMatchObject({ ident: 'RW27', lon: 0, lat: 51.5 })
    expect(distanceNm(at(points[0]!), at(points[1]!))).toBeCloseTo(RUNWAY_NM, 2)
    // Due west along the runway: the latitude does not change.
    expect(points[1]!.lat).toBeCloseTo(51.5, 3)
    expect(points[1]!.lon).toBeLessThan(0)
  })

  it('goes straight on to a first fix ahead of the runway, or one a little off to the side', () => {
    expect(departureLine(RUNWAY_27, [-1, 51.5])).toHaveLength(2)
    // North-west of the end: well within 90 degrees of the runway heading.
    expect(departureLine(RUNWAY_27, [-0.2, 51.8])).toHaveLength(2)
  })

  it('carries the centreline on for a short climb-out when the first fix lies behind the runway end (a SID that turns back)', () => {
    const points = departureLine(RUNWAY_27, [0.5, 51.6])
    expect(points).toHaveLength(3)
    expect(distanceNm(at(points[1]!), at(points[2]!))).toBeCloseTo(CLIMB_OUT_NM, 2)
    // Still on the runway's line, not turned towards the fix.
    expect(points[2]!.lat).toBeCloseTo(51.5, 3)
    expect(points[2]!.lon).toBeLessThan(points[1]!.lon)
  })

  it('treats a fix exactly at the limit as ahead, and one past it as behind', () => {
    expect(FOLD_BACK_DEG).toBe(90)
    const end = departureLine(RUNWAY_27, null)[1]!
    // Due north of the end is 90 degrees off a westerly runway: not behind. A little south of east is.
    expect(departureLine(RUNWAY_27, [end.lon, end.lat + 0.2])).toHaveLength(2)
    expect(departureLine(RUNWAY_27, [end.lon + 0.2, end.lat + 0.01])).toHaveLength(3)
  })

  it('is the runway alone when there is no first fix (no SID, no route)', () => {
    expect(departureLine(RUNWAY_27, null)).toHaveLength(2)
  })

  it('names the start after the runway, whatever its ident', () => {
    expect(departureLine({ ...RUNWAY_27, ident: '20C' }, null)[0]?.ident).toBe('RW20C')
  })

  it('works across the antimeridian', () => {
    const east: DepartureRunway = {
      ident: '09',
      headingTrueDeg: 90,
      lengthM: 3000,
      thresholdLat: 0,
      thresholdLon: 179.99
    }
    const points = departureLine(east, null)
    expect(points[1]!.lon).toBeLessThan(-179)
  })
})
