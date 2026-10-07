import { describe, expect, it } from 'vitest'
import type { NavdataRunway } from '../navdata/navdata-provider'
import { isOnRunway } from './runway-check'

// VHHH's real runways from the navdata cache (2026-10-05).
const VHHH: NavdataRunway[] = [
  {
    ident: '25C',
    headingTrueDeg: 250.8878,
    lengthM: 4223.2,
    widthM: 60.3,
    surface: 0,
    thresholdLat: 22.321955398,
    thresholdLon: 113.932353948
  },
  {
    ident: '07C',
    headingTrueDeg: 70.8878,
    lengthM: 4223.2,
    widthM: 60.3,
    surface: 0,
    thresholdLat: 22.309533894,
    thresholdLon: 113.893605376
  },
  {
    ident: '25L',
    headingTrueDeg: 250.8805,
    lengthM: 3787.4,
    widthM: 60.6,
    surface: 0,
    thresholdLat: 22.307392794,
    thresholdLon: 113.932832502
  },
  {
    ident: '07R',
    headingTrueDeg: 70.8805,
    lengthM: 3787.4,
    widthM: 60.6,
    surface: 0,
    thresholdLat: 22.296249133,
    thresholdLon: 113.898088015
  },
  {
    ident: '25R',
    headingTrueDeg: 250.8877,
    lengthM: 3971.8,
    widthM: 58.9,
    surface: 0,
    thresholdLat: 22.332782165,
    thresholdLon: 113.91714926
  },
  {
    ident: '07L',
    headingTrueDeg: 70.8877,
    lengthM: 3971.8,
    widthM: 58.9,
    surface: 0,
    thresholdLat: 22.321100219,
    thresholdLon: 113.880704985
  }
]

describe('isOnRunway (VHHH, flight 230, 2026-10-05)', () => {
  it('is false on the parallel taxiway where a 35 kt taxi was taken for the takeoff roll', () => {
    // Real samples: 14:07:36Z and 14:07:40Z, ~291 m off 25L's centreline.
    expect(isOnRunway(VHHH, 22.30237804145619, 113.90856781667028)).toBe(false)
    expect(isOnRunway(VHHH, 22.302161743434972, 113.90790418147195)).toBe(false)
  })

  it('is true for the real takeoff roll on 07R', () => {
    // Real samples: 14:10:02Z and 14:10:05Z.
    expect(isOnRunway(VHHH, 22.296865859077617, 113.90006853800166)).toBe(true)
    expect(isOnRunway(VHHH, 22.297086606300695, 113.90070791416504)).toBe(true)
  })

  it('counts the threshold end and the full length, but not well beyond the far end', () => {
    expect(isOnRunway(VHHH, 22.296249133, 113.898088015)).toBe(true)
    // 07R's far end is 25L's threshold.
    expect(isOnRunway(VHHH, 22.307392794, 113.932832502)).toBe(true)
    // ~600 m past 25L's threshold, out over the water.
    expect(isOnRunway(VHHH, 22.30915, 113.9381)).toBe(false)
  })

  it("can't tell with no runways cached, or far from every runway", () => {
    expect(isOnRunway([], 22.296865859, 113.900068538)).toBeNull()
    // ZJSY, ~470 km away.
    expect(isOnRunway(VHHH, 18.3029, 109.4122)).toBeNull()
  })
})
