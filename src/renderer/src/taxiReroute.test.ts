import { describe, expect, it } from 'vitest'
import type { NavdataTaxiSegment } from '@shared/ipc'
import { remainingRoute, traceTaxiRouteDetail, type TracedRouteDetail } from './taxiRouteTrace'
import {
  checkDeviation,
  INITIAL_DEVIATION,
  reachedEnd,
  REROUTE_AFTER_MS,
  REROUTE_DISTANCE_M,
  REROUTE_MIN_INTERVAL_MS,
  stageReached,
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

  it('re-routes at most once per 10 s, and escalates to direct when the last one was recent', () => {
    let state = INITIAL_DEVIATION
    const results: { t: number; direct: boolean }[] = []
    for (let t = 0; t <= 120; t++) {
      const result = checkDeviation(state, sample(t * 1000, { distanceM: 100 }))
      state = result.state
      if (result.reroute) results.push({ t, direct: result.direct })
    }
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.t - results[i - 1]!.t).toBeGreaterThanOrEqual(REROUTE_MIN_INTERVAL_MS / 1000)
    }
    expect(results[0]).toEqual({ t: 5, direct: false })
    expect(results.slice(1).every((r) => r.direct)).toBe(true)
  })

  it('goes back to rejoining the cleared taxiways when the last re-route was over a minute ago', () => {
    const start: DeviationState = { deviatingSince: null, lastRerouteAt: 0 }
    let state = start
    let found: { reroute: boolean; direct: boolean } | null = null
    for (let t = 61; t <= 70 && !found; t++) {
      const result = checkDeviation(state, sample(t * 1000, { distanceM: 100 }))
      state = result.state
      if (result.reroute) found = result
    }
    expect(found).toMatchObject({ reroute: true, direct: false })
  })
})

describe('stageReached and reachedEnd', () => {
  it('only counts a segment as driven within 30 m of it, and never goes back', () => {
    const stages = [-1, 0, 0, 1, 2]
    const at = (segment: number, distanceM: number) => ({ line: [], segment, distanceM, bearingDeg: 0 })
    expect(stageReached(stages, at(3, 10), -1)).toBe(1)
    expect(stageReached(stages, at(3, 31), -1)).toBe(-1)
    expect(stageReached(stages, at(1, 5), 1)).toBe(1)
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
    let detail: TracedRouteDetail = traceTaxiRouteDetail({ ...REQUEST, from: { lat: lat0, lon: lon0 } })!
    const endAt = detail.end
    let progress = 0
    let stage = -1
    let deviation = INITIAL_DEVIATION
    let done = false
    const reroutes: { t: number; direct: boolean; end: [number, number] }[] = []
    let taxiStart: number | null = null
    for (const [t, lat, lon, headingDeg, groundSpeedMs, phase] of SAMPLES) {
      const position = { lat, lon }
      if (phase === 'taxi' && taxiStart === null) taxiStart = t
      let remaining = remainingRoute(detail.route, position, progress)
      stage = stageReached(detail.stages, remaining, stage)
      if (reachedEnd(detail.route, position)) done = true
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
          const next = traceTaxiRouteDetail({ ...REQUEST, from: position, headingDeg, fromStage: stage, endAt, direct: check.direct })
          if (next) {
            detail = next
            remaining = remainingRoute(detail.route, position, 0)
            reroutes.push({ t, direct: check.direct, end: next.route.at(-1)! })
          }
        }
      }
      progress = remaining.segment
    }
    return { reroutes, detail, taxiStart: taxiStart! }
  }

  it('re-routes within 10 s of starting to taxi the wrong way', () => {
    const { reroutes, taxiStart } = replay()
    expect(reroutes.length).toBeGreaterThan(0)
    expect(reroutes[0]!.t - taxiStart).toBeGreaterThanOrEqual(REROUTE_AFTER_MS / 1000)
    expect(reroutes[0]!.t - taxiStart).toBeLessThanOrEqual(10)
  })

  it("ends every re-route at A's runway 08 hold short, the clearance's own end", () => {
    const { reroutes } = replay()
    for (const { end } of reroutes) {
      expect(distanceM({ lat: end[1], lon: end[0] }, RUNWAY_08_HOLD)).toBeLessThan(5)
    }
  })

  it('ends the final line where Callum actually held', () => {
    const { detail } = replay()
    const [lon, lat] = detail.route.at(-1)!
    expect(distanceM({ lat, lon }, HELD_AT)).toBeLessThan(30)
  })

  it("doesn't keep fighting the pilot: a handful of re-routes over the whole taxi, not one every 10 s", () => {
    const { reroutes } = replay()
    // Rejoining the cleared taxiways every time re-routed 13 times here, each one pointing
    // back east to D; escalating to direct settles it.
    expect(reroutes.length).toBeLessThanOrEqual(5)
    expect(reroutes.some((r) => r.direct)).toBe(true)
  })

  it('stops re-routing once at the hold: lining up on the runway is not a deviation', () => {
    const { reroutes } = replay()
    const heldFrom = SAMPLES.find(([, lat, lon]) => distanceM({ lat, lon }, HELD_AT) < 5)![0]
    expect(reroutes.every((r) => r.t < heldFrom)).toBe(true)
  })
})
