import { describe, expect, it } from 'vitest'
import { destinationPoint } from '@shared/geo'
import type { NavdataTaxiSegment } from '@shared/ipc'
import {
  passesAPlaceTwice,
  pointsAlong,
  routeProblems,
  sharpestTurn,
  type RouteCheckRequest,
  type Xy
} from './route-checks'
import { traceTaxiRoute, type TracedRoute } from './route-trace'
import ZJSY_RAW from './__fixtures__/zjsy-taxi-d-b7-a.json'

// ZJSY, the whole airport (MSFS facility data from WingLog's cache). Rows: [startLat, startLon, endLat, endLon, name,
// startHoldShort, endHoldShort].
type Row = [number, number, number, number, string | null, number, number]
const ZJSY: NavdataTaxiSegment[] = (ZJSY_RAW as Row[]).map(
  ([startLat, startLon, endLat, endLon, name, startHoldShort, endHoldShort]) => ({
    startLat,
    startLon,
    endLat,
    endLon,
    name,
    startHoldShort: startHoldShort === 1,
    endHoldShort: endHoldShort === 1
  })
)

/** The real clearance "holding point A, runway 08, via D, B7, A", from flight 253's start, to A's only hold short. */
const ON_D = { lat: 18.3074072, lon: 109.4093493 }
const RUNWAY_08_HOLD = { lat: 18.30168, lon: 109.39634 }
const ZJSY_REQUEST: RouteCheckRequest = {
  segments: ZJSY,
  taxiways: ['D', 'B7', 'A'],
  holdingPoint: 'A',
  from: ON_D
}

/** A route that starts at a point and goes on each leg's bearing for its length, as [lon, lat]. */
function walk(
  start: { lat: number; lon: number },
  legs: [bearingDeg: number, metres: number][]
): TracedRoute {
  const route: TracedRoute = [[start.lon, start.lat]]
  let at = start
  for (const [bearing, metres] of legs) {
    at = destinationPoint(at, bearing, metres)
    route.push([at.lon, at.lat])
  }
  return route
}

const HERE = { lat: 51.47, lon: -0.45 }
/** A request with nothing to check beyond the route's own shape. */
const BARE: RouteCheckRequest = { segments: [], taxiways: [], holdingPoint: null, from: HERE }

describe('routeProblems', () => {
  const real = traceTaxiRoute(ZJSY_REQUEST)!

  it('passes the real ZJSY route, with and without the end given and with the nose pointing along it', () => {
    expect(real).not.toBeNull()
    expect(routeProblems(real, ZJSY_REQUEST)).toEqual([])
    expect(routeProblems(real, { ...ZJSY_REQUEST, end: RUNWAY_08_HOLD })).toEqual([])
    const [a, b] = [real[0], real[real.findIndex((p) => p[0] !== real[0][0] || p[1] !== real[0][1])]]
    const along =
      ((Math.atan2((b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180), b[1] - a[1]) * 180) / Math.PI + 360) %
      360
    expect(routeProblems(real, { ...ZJSY_REQUEST, headingDeg: along })).toEqual([])
  })

  it('has nothing to say about no route at all', () => {
    expect(routeProblems([], BARE)).toEqual(['no-route'])
    expect(routeProblems([[HERE.lon, HERE.lat]], BARE)).toEqual(['no-route'])
  })

  describe('misses the end', () => {
    it('when it stops far from the end the caller gave', () => {
      const elsewhere = destinationPoint(RUNWAY_08_HOLD, 0, 400)
      expect(routeProblems(real, { ...ZJSY_REQUEST, end: elsewhere })).toEqual(['misses-end'])
    })

    it('when a holding-point clearance ends away from that taxiway', () => {
      expect(routeProblems(real, { ...ZJSY_REQUEST, holdingPoint: 'B7' })).toContain('misses-end')
    })

    it('when a hold short of a runway clearance ends away from every hold short', () => {
      const midway = real.slice(0, Math.floor(real.length / 2))
      const request = { ...ZJSY_REQUEST, holdingPoint: null, holdShortRunway: { lengthM: 1 } as never }
      expect(routeProblems(real, request)).toEqual([])
      expect(routeProblems(midway, request)).toContain('misses-end')
    })

    it('when a stand clearance ends away from the stand and from the network point nearest it', () => {
      const stand = destinationPoint(RUNWAY_08_HOLD, 90, 600)
      expect(routeProblems(real, { ...ZJSY_REQUEST, holdingPoint: null, stand })).toContain('misses-end')
      const hold = real.at(-1)!
      expect(
        routeProblems(real, { ...ZJSY_REQUEST, holdingPoint: null, stand: { lat: hold[1], lon: hold[0] } })
      ).toEqual([])
    })

    it('when a clearance of taxiways alone ends off the last one', () => {
      const request = { ...ZJSY_REQUEST, holdingPoint: null }
      expect(routeProblems(real, request)).toEqual([])
      expect(routeProblems(real, { ...request, taxiways: ['D', 'B7', 'B8'] })).toContain('misses-end')
    })
  })

  it('finds a sharp turn: 170° within 60 m is more than an airliner turns', () => {
    // A short way back, so it is not also a lap.
    const route = walk(HERE, [
      [90, 200],
      [260, 40]
    ])
    expect(routeProblems(route, BARE)).toEqual(['sharp-turn'])
  })

  it('calls a long way back along itself a sharp turn and a lap both', () => {
    const route = walk(HERE, [
      [90, 200],
      [260, 200]
    ])
    expect(routeProblems(route, BARE)).toEqual(['sharp-turn', 'passes-a-place-twice'])
  })

  it('does not call a gentle bend sharp: 90° in one turn is allowed', () => {
    const route = walk(HERE, [
      [90, 200],
      [180, 200]
    ])
    expect(routeProblems(route, BARE)).toEqual([])
  })

  it('finds a lap: coming back to a place passed 800 m earlier, with no sharp turn anywhere', () => {
    // An octagon of 100 m sides ending where it began: eight 45° turns, a place visited twice.
    const octagon = walk(
      HERE,
      Array.from({ length: 8 }, (_, i): [number, number] => [i * 45, 100])
    )
    expect(routeProblems(octagon, BARE)).toEqual(['passes-a-place-twice'])
  })

  it('finds a taxiway driven in more runs than the clearance names it', () => {
    // A runs, B joins it, then A again: "via A, B" does not name A twice.
    const origin = HERE
    const p = (east: number, north: number) => destinationPoint(destinationPoint(origin, 90, east), 0, north)
    const seg = (
      a: { lat: number; lon: number },
      b: { lat: number; lon: number },
      name: string
    ): NavdataTaxiSegment => ({
      startLat: a.lat,
      startLon: a.lon,
      endLat: b.lat,
      endLon: b.lon,
      name,
      startHoldShort: false,
      endHoldShort: false
    })
    const [p0, p1, p2, p3] = [p(0, 0), p(100, 0), p(100, 100), p(200, 100)]
    const segments = [seg(p0, p1, 'A'), seg(p1, p2, 'B'), seg(p2, p3, 'A')]
    const route: TracedRoute = [p0, p1, p2, p3].map((q) => [q.lon, q.lat])
    const end = p3
    expect(routeProblems(route, { ...BARE, segments, taxiways: ['A', 'B'], end })).toEqual([
      'taxiway-driven-again'
    ])
    expect(routeProblems(route, { ...BARE, segments, taxiways: ['A', 'B', 'A'], end })).toEqual([])
  })

  describe('starts behind the nose', () => {
    const route = walk(HERE, [[90, 200]])

    it('when the first 40 m point more than 90° from the heading', () => {
      expect(routeProblems(route, { ...BARE, headingDeg: 270 })).toEqual(['starts-behind-nose'])
      expect(routeProblems(route, { ...BARE, headingDeg: 180 })).toEqual([])
      expect(routeProblems(route, { ...BARE, headingDeg: 90 })).toEqual([])
    })

    it('not when the heading is not known', () => {
      expect(routeProblems(route, { ...BARE, headingDeg: null })).toEqual([])
      expect(routeProblems(route, BARE)).toEqual([])
    })

    it('not for a route too short to point anywhere', () => {
      expect(routeProblems(walk(HERE, [[90, 2]]), { ...BARE, headingDeg: 270 })).toEqual([])
    })
  })

  it('finds a route longer than any taxi: 16 km', () => {
    const route = walk(
      HERE,
      Array.from({ length: 16 }, (): [number, number] => [90, 1000])
    )
    expect(routeProblems(route, BARE)).toEqual(['too-long'])
  })

  it('lists every problem a route has', () => {
    const route = walk(HERE, [
      [90, 200],
      [260, 40]
    ])
    expect(routeProblems(route, { ...BARE, headingDeg: 270 })).toEqual(['sharp-turn', 'starts-behind-nose'])
  })
})

describe('sharpestTurn', () => {
  const line = (...pts: Xy[]): Xy[] => pts

  it('is nothing on a straight line, and the angle at a corner', () => {
    expect(sharpestTurn(line([0, 0], [0, 50], [0, 100]))).toBe(0)
    expect(sharpestTurn(line([0, 0], [0, 50], [50, 50]))).toBeCloseTo(90)
  })

  it('adds the turns inside the window and not those outside it', () => {
    // Two 90° corners 50 m apart count together; 200 m apart they do not.
    expect(sharpestTurn(line([0, 0], [0, 50], [50, 50], [50, 70], [0, 70]))).toBeCloseTo(180)
    expect(sharpestTurn(line([0, 0], [0, 50], [200, 50], [200, 250], [0, 250]))).toBeCloseTo(90)
  })

  it('ignores a kink in a segment shorter than half a metre', () => {
    expect(sharpestTurn(line([0, 0], [0, 50], [0.1, 50.1], [0, 100]))).toBeLessThan(1)
  })
})

describe('passesAPlaceTwice and pointsAlong', () => {
  it('is false for a line that does not come back, and true for one that returns to a place 150 m or more on', () => {
    expect(
      passesAPlaceTwice([
        [0, 0],
        [500, 0]
      ])
    ).toBe(false)
    expect(
      passesAPlaceTwice([
        [0, 0],
        [100, 0],
        [100, 100],
        [0, 100],
        [0, 5]
      ])
    ).toBe(true)
    expect(
      passesAPlaceTwice([
        [0, 0],
        [100, 0],
        [100, 40],
        [0, 40]
      ])
    ).toBe(false)
  })

  it('spaces points along a line, each standing for its share of the length', () => {
    const points = pointsAlong(
      [
        [0, 0],
        [100, 0]
      ],
      5
    )
    expect(points).toHaveLength(20)
    expect(points.reduce((sum, p) => sum + p.m, 0)).toBeCloseTo(100)
    expect(points[0].at).toBeCloseTo(2.5)
    expect(points.at(-1)!.at).toBeCloseTo(97.5)
  })
})
