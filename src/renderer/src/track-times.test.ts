import { describe, expect, it } from 'vitest'
import {
  computeTrackTimes,
  formatDuration,
  formatElapsed,
  formatUtcTime,
  remainingRouteNm
} from './track-times'

// A cut-down YBBN-VHHH (the real flight, 2026-10-02): YBBN, BARIA (the step climb fix), MIA
// (Manila), VHHH. [lon, lat].
const YBBN: [number, number] = [153.117, -27.384]
const BARIA: [number, number] = [149.5, -21.5]
const MIA: [number, number] = [120.98, 14.5]
const VHHH: [number, number] = [113.918, 22.308]
const ROUTE = [YBBN, BARIA, MIA, VHHH]

const at = (lonLat: [number, number]): { lat: number; lon: number } => ({ lat: lonLat[1], lon: lonLat[0] })

describe('remainingRouteNm', () => {
  it('is the whole route at the start, and nothing at the end', () => {
    const whole = remainingRouteNm(ROUTE, at(YBBN))!
    // Real great-circle legs: ~410 + ~2,700 + ~580 nm.
    expect(whole).toBeGreaterThan(3600)
    expect(whole).toBeLessThan(3800)
    expect(remainingRouteNm(ROUTE, at(VHHH))).toBeCloseTo(0, 5)
  })

  it('follows the route around its turn rather than going straight to the destination', () => {
    const fromManila = remainingRouteNm(ROUTE, at(MIA))!
    const legMiaVhhh = remainingRouteNm([MIA, VHHH], at(MIA))!
    expect(fromManila).toBeCloseTo(legMiaVhhh, 5)

    // Partway along BARIA-MIA, a little off track: the rest of that leg plus MIA-VHHH.
    const midLeg = { lat: (BARIA[1] + MIA[1]) / 2 + 0.2, lon: (BARIA[0] + MIA[0]) / 2 }
    const remaining = remainingRouteNm(ROUTE, midLeg)!
    expect(remaining).toBeGreaterThan(legMiaVhhh + 1300)
    expect(remaining).toBeLessThan(legMiaVhhh + 1400)
  })

  it('has nothing to measure without a route', () => {
    expect(remainingRouteNm([], at(YBBN))).toBeNull()
    expect(remainingRouteNm([VHHH], at(YBBN))).toBeNull()
  })
})

describe('computeTrackTimes', () => {
  const NOW = Date.parse('2026-10-02T06:00:00Z')
  const base = {
    route: ROUTE,
    position: at(MIA),
    groundSpeedMs: 250, // ~486 kt
    onGround: false,
    takeoffUtc: '2026-10-01T23:45:09Z',
    schedInUtc: '2026-10-02T07:15:00Z',
    now: NOW
  }

  it('estimates from ground speed along the rest of the route, against the schedule', () => {
    const times = computeTrackTimes(base)
    const remainingNm = remainingRouteNm(ROUTE, at(MIA))!
    expect(times.remainingMs).toBeCloseTo(((remainingNm * 1852) / 250) * 1000, -3)
    expect(times.etaMs).toBe(NOW + times.remainingMs!)
    expect(times.etaIsPlanned).toBe(false)
    expect(times.vsScheduleMin).toBe(Math.round((times.etaMs! - Date.parse('2026-10-02T07:15:00Z')) / 60_000))
    // ET: 23:45:09 → 06:00:00 is 6 h 14 min 51 s.
    expect(formatDuration(times.elapsedMs)).toBe('6:14')
  })

  it('falls back to the scheduled arrival on the ground, with no time remaining and no ET before takeoff', () => {
    const times = computeTrackTimes({
      ...base,
      position: at(YBBN),
      onGround: true,
      groundSpeedMs: 8,
      takeoffUtc: null
    })
    expect(times).toEqual({
      elapsedMs: null,
      remainingMs: null,
      etaMs: Date.parse('2026-10-02T07:15:00Z'),
      etaIsPlanned: true,
      vsScheduleMin: null
    })
  })

  it('still estimates a free flight with no schedule, just without ahead/behind', () => {
    const times = computeTrackTimes({ ...base, schedInUtc: null })
    expect(times.etaMs).not.toBeNull()
    expect(times.vsScheduleMin).toBeNull()
  })

  it('gives nothing at all with no route, no schedule and no position', () => {
    expect(computeTrackTimes({ ...base, route: [], schedInUtc: null, position: null })).toMatchObject({
      remainingMs: null,
      etaMs: null,
      etaIsPlanned: false
    })
  })
})

describe('formatting', () => {
  it('formats durations as h:mm and UTC times with a Z', () => {
    expect(formatDuration(5 * 3_600_000 + 7 * 60_000 + 59_000)).toBe('5:07')
    expect(formatDuration(null)).toBe('--:--')
    expect(formatUtcTime(Date.parse('2026-10-02T08:01:30Z'))).toBe('08:01Z')
    expect(formatUtcTime(null)).toBe('--:--')
  })

  it('formats ET with seconds (Callum, 2026-10-02), hours unpadded', () => {
    expect(formatElapsed(0)).toBe('0:00:00')
    expect(formatElapsed(59_999)).toBe('0:00:59')
    expect(formatElapsed(3_601_000)).toBe('1:00:01')
    // The YBBN-VHHH block: 8 h 47 m 12 s.
    expect(formatElapsed((8 * 3600 + 47 * 60 + 12) * 1000)).toBe('8:47:12')
    expect(formatElapsed((13 * 3600 + 5 * 60 + 9) * 1000)).toBe('13:05:09')
    expect(formatElapsed(null)).toBe('--:--:--')
  })
})
