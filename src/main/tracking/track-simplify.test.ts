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
    pressureAltitudeM: null,
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
    resumeSegment: 0,
    simRate: 1,
    excludedReason: null,
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

  describe('on the ground', () => {
    // Local metres around EGLL, converted to lat/lon, so shapes can be built at real taxiway
    // scale (a taxiway is ~23m wide; parallel taxiways are often 100-200m apart).
    const ORIGIN_LAT = 51.4775
    const ORIGIN_LON = -0.4614
    const M_PER_DEG_LAT = 111_320
    const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((ORIGIN_LAT * Math.PI) / 180)
    const toLatLon = (x: number, y: number) => ({
      latitude: ORIGIN_LAT + y / M_PER_DEG_LAT,
      longitude: ORIGIN_LON + x / M_PER_DEG_LON
    })
    const toXY = (p: TrackPoint) => ({
      x: (p.longitude - ORIGIN_LON) * M_PER_DEG_LON,
      y: (p.latitude - ORIGIN_LAT) * M_PER_DEG_LAT
    })

    function taxiPoint(id: number, x: number, y: number): TrackPoint {
      return point({
        id,
        ...toLatLon(x, y),
        onGround: true,
        phase: 'taxi',
        altitudeM: 25,
        altitudeAglM: 0,
        indicatedAirspeedMs: 8,
        groundSpeedMs: 8
      })
    }

    /** Points every `step` metres along a polyline of [x, y] vertices. */
    function along(vertices: [number, number][], step: number): [number, number][] {
      const out: [number, number][] = [vertices[0]]
      for (let v = 1; v < vertices.length; v++) {
        const [ax, ay] = vertices[v - 1]
        const [bx, by] = vertices[v]
        const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / step))
        for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n])
      }
      return out
    }

    /** Worst distance from any original point to the simplified polyline, in metres. */
    function worstCut(original: TrackPoint[], kept: TrackPoint[]): number {
      const keptXY = kept.map(toXY)
      let worst = 0
      for (const p of original.map(toXY)) {
        let best = Infinity
        for (let i = 1; i < keptXY.length; i++) {
          const a = keptXY[i - 1]
          const b = keptXY[i]
          const dx = b.x - a.x
          const dy = b.y - a.y
          const len2 = dx * dx + dy * dy
          const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
          best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)))
        }
        worst = Math.max(worst, best)
      }
      return worst
    }

    it('keeps an L-turn taxi with a 25m fillet within 5m, then still collapses the airborne leg at 100m', () => {
      // 300m east, a 25m-radius quarter turn to the north, 300m north; points every 10m.
      const fillet: [number, number][] = Array.from({ length: 9 }, (_, k) => {
        const angle = -Math.PI / 2 + (k / 8) * (Math.PI / 2)
        return [300 + 25 * Math.cos(angle), 25 + 25 * Math.sin(angle)]
      })
      const path = along([[0, 0], ...fillet, [325, 325]], 10)
      const ground = path.map(([x, y], i) => taxiPoint(i, x, y))
      // Airborne: a straight 20km climb-out with a 60m sideways wobble half way, which the
      // 100m air tolerance should still erase.
      const airborne = Array.from({ length: 100 }, (_, k) => {
        const id = ground.length + k
        const wobble = k === 50 ? 60 : 0
        return point({ id, ...toLatLon(325 + wobble, 525 + k * 200), altitudeM: 1000, verticalSpeedMs: 0 })
      })
      const points = [...ground, ...airborne]

      const result = simplifyTrackPoints(points)
      const keptGround = result.filter((p) => p.onGround)

      expect(worstCut(ground, keptGround)).toBeLessThanOrEqual(5)
      // Both ends of the ground run survive, so the air/ground join stays where it was.
      expect(keptGround[0]).toBe(ground[0])
      expect(keptGround[keptGround.length - 1]).toBe(ground[ground.length - 1])
      // The air leg is unchanged: the 60m wobble is gone, only a couple of points remain.
      expect(result.includes(airborne[50])).toBe(false)
      expect(result.filter((p) => !p.onGround).length).toBeLessThan(5)
    })

    it('keeps a jog between parallel taxiways 60m apart, which 100m alone would draw straight across', () => {
      // East on one taxiway, a short connector north, then east on the parallel one.
      const path = along(
        [
          [0, 0],
          [400, 0],
          [430, 60],
          [830, 60]
        ],
        10
      )
      const ground = path.map(([x, y], i) => taxiPoint(i, x, y))

      const result = simplifyTrackPoints(ground)

      expect(worstCut(ground, result)).toBeLessThanOrEqual(5)
      expect(result.length).toBeLessThan(ground.length / 4)
    })

    it('keeps the turn-around point of a pushback that then taxis forward over the same line', () => {
      // Pushed back 60m south, then taxied 300m north along the same centreline. Every point
      // is collinear, so a line distance scores the turn-around as 0m off and drops it.
      const path = [
        ...along(
          [
            [0, 0],
            [0, -60]
          ],
          5
        ),
        ...along(
          [
            [0, -60],
            [0, 240]
          ],
          10
        ).slice(1)
      ]
      const ground = path.map(([x, y], i) => taxiPoint(i, x, y))

      const result = simplifyTrackPoints(ground)

      expect(worstCut(ground, result)).toBeLessThanOrEqual(5)
    })

    it('treats each on-ground run separately (taxi out, flight, taxi in)', () => {
      const taxiOut = along(
        [
          [0, 0],
          [200, 0],
          [200, 200]
        ],
        10
      ).map(([x, y], i) => taxiPoint(i, x, y))
      const flight = Array.from({ length: 50 }, (_, k) =>
        point({ id: 1000 + k, ...toLatLon(200, 400 + k * 500) })
      )
      const taxiIn = along(
        [
          [200, 26_000],
          [400, 26_000],
          [400, 26_200]
        ],
        10
      ).map(([x, y], i) => taxiPoint(2000 + i, x, y))

      const result = simplifyTrackPoints([...taxiOut, ...flight, ...taxiIn])

      expect(
        worstCut(
          taxiOut,
          result.filter((p) => taxiOut.includes(p))
        )
      ).toBeLessThanOrEqual(5)
      expect(
        worstCut(
          taxiIn,
          result.filter((p) => taxiIn.includes(p))
        )
      ).toBeLessThanOrEqual(5)
    })
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
