import { describe, expect, it } from 'vitest'
import type { NavdataTaxiSegment } from '@shared/ipc'
import { rejoinTaxiRoute, remainingRoute, traceTaxiRoute, type TracedRoute } from './taxiRouteTrace'
import {
  checkDeviation,
  INITIAL_DEVIATION,
  reachedEnd,
  REROUTE_AFTER_MS,
  REROUTE_DISTANCE_M,
  REROUTE_MIN_INTERVAL_MS,
  segmentDriven,
  type DeviationState
} from './taxiReroute'
import ZJSY_RAW from './__fixtures__/zjsy-taxi-d-b7-a.json'
// Flight 227's real taxi out at ZJSY, 2026-10-02: from the stand through the wrong-way
// pushback to the runway 08 hold and lining up. Anonymised to what the replay needs. Rows:
// [seconds from the first row, lat, lon, true heading, ground speed m/s, phase]. Pushback is
// recorded at 1 s, taxi at 3 s (the taxi interval then).
import REPLAY_227 from './__fixtures__/zjsy-227-taxi-out.json'

type Row = [number, number, number, number, string | null, number, number]
const ZJSY: NavdataTaxiSegment[] = (ZJSY_RAW as Row[]).map(([startLat, startLon, endLat, endLon, name, startHoldShort, endHoldShort]) => ({
  startLat,
  startLon,
  endLat,
  endLon,
  name,
  startHoldShort: startHoldShort === 1,
  endHoldShort: endHoldShort === 1
}))
type Sample = [number, number, number, number, number, string]
const SAMPLES = REPLAY_227 as Sample[]

function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  return Math.hypot((a.lat - b.lat) * 111_320, (a.lon - b.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180))
}

describe('checkDeviation', () => {
  const sample = (nowMs: number, overrides: { distanceM?: number; lineBearingDeg?: number | null; headingDeg?: number; groundSpeedMs?: number } = {}) => ({
    nowMs,
    distanceM: 0,
    lineBearingDeg: 90,
    headingDeg: 90,
    groundSpeedMs: 5,
    ...overrides
  })
  /** Feeds one sample a second from t = 0 to `seconds`, all the same apart from the time. */
  function run(seconds: number, overrides: Parameters<typeof sample>[1], start: DeviationState = INITIAL_DEVIATION) {
    let state = start
    const reroutes: number[] = []
    for (let t = 0; t <= seconds; t++) {
      const result = checkDeviation(state, sample(t * 1000, overrides))
      state = result.state
      if (result.reroute) reroutes.push(t)
    }
    return { state, reroutes }
  }

  it('never triggers 39 m off the line', () => {
    expect(run(60, { distanceM: REROUTE_DISTANCE_M - 1 }).reroutes).toEqual([])
  })

  it('triggers 41 m off only once that has lasted 5 s: not after 4 s, yes after 6 s', () => {
    expect(run(4, { distanceM: REROUTE_DISTANCE_M + 1 }).reroutes).toEqual([])
    expect(run(6, { distanceM: REROUTE_DISTANCE_M + 1 }).reroutes).toEqual([REROUTE_AFTER_MS / 1000])
  })

  it('never triggers while stationary, however far off', () => {
    expect(run(60, { distanceM: 500, groundSpeedMs: 0 }).reroutes).toEqual([])
  })

  it('starts the 5 s again after a pause or a return to the line (cutting a corner)', () => {
    let state = INITIAL_DEVIATION
    for (let t = 0; t <= 3; t++) state = checkDeviation(state, sample(t * 1000, { distanceM: 60 })).state
    state = checkDeviation(state, sample(4000, { distanceM: 10 })).state
    const results = [5, 6, 7, 8].map((t) => {
      const result = checkDeviation(state, sample(t * 1000, { distanceM: 60 }))
      state = result.state
      return result.reroute
    })
    expect(results).toEqual([false, false, false, false])
  })

  it('triggers on the line when driving the wrong way along it', () => {
    expect(run(6, { distanceM: 2, lineBearingDeg: 82, headingDeg: 262 }).reroutes).toEqual([5])
    // 110° off is a turn onto the line, not the wrong way.
    expect(run(60, { distanceM: 2, lineBearingDeg: 0, headingDeg: 110 }).reroutes).toEqual([])
  })

  it('re-routes at most once per 10 s while the deviation goes on', () => {
    const { reroutes } = run(60, { distanceM: 100 })
    expect(reroutes[0]).toBe(5)
    for (let k = 1; k < reroutes.length; k++) {
      expect(reroutes[k]! - reroutes[k - 1]!).toBeGreaterThanOrEqual(REROUTE_MIN_INTERVAL_MS / 1000)
    }
  })
})

describe('segmentDriven and reachedEnd', () => {
  it('only counts a segment as driven within 30 m of it, and never goes back', () => {
    const at = (segment: number, distanceM: number) => ({ line: [], segment, distanceM, bearingDeg: 0 })
    expect(segmentDriven(at(3, 10), 0)).toBe(3)
    expect(segmentDriven(at(3, 31), 0)).toBe(0)
    expect(segmentDriven(at(1, 5), 3)).toBe(3)
  })

  it('is at the end within 30 m of the last point', () => {
    const route: [number, number][] = [
      [109.4, 18.3],
      [109.39634, 18.30168]
    ]
    expect(reachedEnd(route, { lat: 18.301915, lon: 109.396319 })).toBe(true) // 26 m
    expect(reachedEnd(route, { lat: 18.3021, lon: 109.39634 })).toBe(false) // 47 m
    expect(reachedEnd([], { lat: 0, lon: 0 })).toBe(false)
  })
})

describe('re-routing replay: ZJSY flight 227, the wrong-way pushback (2026-10-02)', () => {
  // A's only hold-short point, by the runway 08 threshold, and where Callum actually held.
  const RUNWAY_08_HOLD = { lat: 18.30168, lon: 109.39634 }
  const HELD_AT = { lat: 18.301915, lon: 109.396319 }
  const REQUEST = { segments: ZJSY, taxiways: ['D', 'B7', 'A'], holdingPoint: 'A' }

  /** What useTaxiRouteHighlight does on each position update, with the replay's own clock. */
  function replay() {
    const [, lat0, lon0] = SAMPLES[0]!
    const cleared: TracedRoute = traceTaxiRoute({ ...REQUEST, from: { lat: lat0, lon: lon0 } })!
    let line = cleared
    let progress = 0
    let driven = 0
    let deviation = INITIAL_DEVIATION
    let done = false
    const reroutes: { t: number; line: TracedRoute }[] = []
    /** How far off the line the aircraft was at each taxi sample after the last re-route. */
    let offAfterLast: number[] = []
    let taxiStart: number | null = null
    for (const [t, lat, lon, headingDeg, groundSpeedMs, phase] of SAMPLES) {
      const position = { lat, lon }
      if (phase === 'taxi' && taxiStart === null) taxiStart = t
      let remaining = remainingRoute(line, position, progress)
      driven = segmentDriven(remainingRoute(cleared, position, driven), driven)
      if (reachedEnd(line, position)) done = true
      if (phase === 'taxi' && !done) {
        const check = checkDeviation(deviation, {
          nowMs: t * 1000,
          distanceM: remaining.distanceM,
          lineBearingDeg: remaining.bearingDeg,
          headingDeg,
          groundSpeedMs
        })
        deviation = check.state
        if (check.reroute) {
          const next = rejoinTaxiRoute({ segments: ZJSY, route: cleared, fromSegment: driven, from: position, headingDeg })
          if (next) {
            line = next
            remaining = remainingRoute(line, position, 0)
            reroutes.push({ t, line: next })
            offAfterLast = []
          }
        }
        offAfterLast.push(remaining.distanceM)
      }
      progress = remaining.segment
    }
    return { reroutes, cleared, line, offAfterLast, taxiStart: taxiStart! }
  }

  it('re-routes within 10 s of starting to taxi the wrong way', () => {
    const { reroutes, taxiStart } = replay()
    expect(reroutes.length).toBeGreaterThan(0)
    expect(reroutes[0]!.t - taxiStart).toBeGreaterThanOrEqual(REROUTE_AFTER_MS / 1000)
    expect(reroutes[0]!.t - taxiStart).toBeLessThanOrEqual(10)
  })

  it("ends every re-route at A's runway 08 hold short, the clearance's own end", () => {
    const { reroutes } = replay()
    for (const { line } of reroutes) {
      const [lon, lat] = line.at(-1)!
      expect(distanceM({ lat, lon }, RUNWAY_08_HOLD)).toBeLessThan(5)
    }
  })

  it('ends the final line where Callum actually held', () => {
    const { line } = replay()
    const [lon, lat] = line.at(-1)!
    expect(distanceM({ lat, lon }, HELD_AT)).toBeLessThan(30)
  })

  it('rejoins the cleared route near the hold, the way the pilot went, not back at D', () => {
    const { reroutes, cleared } = replay()
    // Every re-route joins the cleared route on its last stretch along A, not its start on D:
    // what's left of the cleared route after the join is under a third of it.
    const lengthOf = (route: TracedRoute): number =>
      route.slice(1).reduce((sum, [lon, lat], k) => sum + distanceM({ lat, lon }, { lat: route[k]![1], lon: route[k]![0] }), 0)
    for (const { line } of reroutes) {
      const joinIndex = cleared.findIndex((p) => line.some((q) => q[0] === p[0] && q[1] === p[1]))
      expect(lengthOf(cleared.slice(joinIndex))).toBeLessThan(lengthOf(cleared) / 3)
    }
  })

  it("doesn't keep fighting the pilot: a handful of re-routes, then the pilot follows the line to the hold", () => {
    const { reroutes, offAfterLast } = replay()
    expect(reroutes.length).toBeLessThanOrEqual(4)
    expect(Math.max(...offAfterLast)).toBeLessThan(REROUTE_DISTANCE_M)
  })

  it('stops re-routing once at the hold: lining up on the runway is not a deviation', () => {
    const { reroutes } = replay()
    const heldFrom = SAMPLES.find(([, lat, lon]) => distanceM({ lat, lon }, HELD_AT) < 5)![0]
    expect(reroutes.every((r) => r.t < heldFrom)).toBe(true)
  })
})
