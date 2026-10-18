import { describe, expect, it } from 'vitest'
import {
  destinationPoint,
  flatDistanceM,
  greatCircleM,
  greatCircleNm,
  initialBearingDeg,
  offsetBy,
  offsetFrom,
  pointToLineM,
  pointToSegmentM,
  wrapLongitude
} from './geo'

// Real aerodrome reference points.
const EGLL = { lat: 51.4706, lon: -0.4619 }
const KJFK = { lat: 40.6413, lon: -73.7781 }
const VHHH = { lat: 22.308, lon: 113.9185 }
const WSSS = { lat: 1.3644, lon: 103.9915 }
const LFPG = { lat: 49.0097, lon: 2.5479 }

describe('great circle', () => {
  it('gives the published distances between real airports', () => {
    expect(greatCircleNm(EGLL, KJFK)).toBeCloseTo(2991, -1) // 5,540 km
    expect(greatCircleNm(VHHH, WSSS)).toBeCloseTo(1389, -1) // 2,573 km
    expect(greatCircleNm(EGLL, LFPG)).toBeCloseTo(187.6, 0)
    expect(greatCircleM(EGLL, EGLL)).toBe(0)
  })

  it('makes one degree of latitude 60 nm', () => {
    expect(greatCircleNm({ lat: 45, lon: 30 }, { lat: 46, lon: 30 })).toBeCloseTo(60, 0)
  })

  it('gives the initial bearing, 0 to 360', () => {
    expect(initialBearingDeg({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(0, 5)
    expect(initialBearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeCloseTo(90, 5)
    expect(initialBearingDeg({ lat: 0, lon: 0 }, { lat: -1, lon: 0 })).toBeCloseTo(180, 5)
    expect(initialBearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: -1 })).toBeCloseTo(270, 5)
    expect(initialBearingDeg(EGLL, KJFK)).toBeCloseTo(288.1, 0)
  })

  it('finds the destination point back again by distance and bearing', () => {
    const to = destinationPoint(EGLL, 135, 20 * 1852)
    expect(greatCircleNm(EGLL, to)).toBeCloseTo(20, 6)
    expect(initialBearingDeg(EGLL, to)).toBeCloseTo(135, 1)
  })

  it('leaves the destination longitude unwrapped, and wraps it on request', () => {
    const across = destinationPoint({ lat: 0, lon: 179.9 }, 90, 50_000)
    expect(across.lon).toBeGreaterThan(180)
    expect(wrapLongitude(across.lon)).toBeCloseTo(across.lon - 360, 9)
    expect(wrapLongitude(-190)).toBeCloseTo(170, 9)
    expect(wrapLongitude(10)).toBeCloseTo(10, 9)
  })
})

describe('local flat projection', () => {
  // VHHH runway 07R threshold, from the sim's navdata.
  const THRESHOLD = { lat: 22.296249133, lon: 113.898088015 }

  it('agrees with the great circle at airport scale', () => {
    const far = offsetBy(THRESHOLD, 3000, 1000)
    expect(flatDistanceM(THRESHOLD, far)).toBeCloseTo(Math.hypot(3000, 1000), 6)
    expect(Math.abs(flatDistanceM(THRESHOLD, far) - greatCircleM(THRESHOLD, far))).toBeLessThan(5)
  })

  it('round-trips an offset', () => {
    const p = offsetBy(THRESHOLD, -250, 400)
    const back = offsetFrom(THRESHOLD, p)
    expect(back.eastM).toBeCloseTo(-250, 6)
    expect(back.northM).toBeCloseTo(400, 6)
  })

  it('measures to the line, and to the segment only between its ends', () => {
    const a = THRESHOLD
    const b = offsetBy(THRESHOLD, 1000, 0)
    const beside = offsetBy(THRESHOLD, 500, 30)
    const beyond = offsetBy(THRESHOLD, 1400, 30)
    expect(pointToLineM(beside, a, b)).toBeCloseTo(30, 1)
    expect(pointToSegmentM(beside, a, b)).toBeCloseTo(30, 1)
    expect(pointToLineM(beyond, a, b)).toBeCloseTo(30, 1)
    expect(pointToSegmentM(beyond, a, b)).toBeCloseTo(Math.hypot(400, 30), 0)
    expect(pointToLineM(beside, a, a)).toBeCloseTo(Math.hypot(500, 30), 0)
  })
})
