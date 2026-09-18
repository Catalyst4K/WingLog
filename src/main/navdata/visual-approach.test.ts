import { describe, expect, it } from 'vitest'
import {
  VISUAL_JOIN_DISTANCE_NM,
  visualApproachLegs,
  visualApproachOptions,
  type VisualRunwayEnd
} from './visual-approach'

/** Great-circle distance in metres — independent of the code under test. */
function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180
  const dLat = (lat2 - lat1) * rad
  const dLon = (lon2 - lon1) * rad
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2
  return 2 * 6371008.8 * Math.asin(Math.sqrt(a))
}

const EGLL_27R: VisualRunwayEnd = { ident: '27R', headingTrueDeg: 270, thresholdLat: 51.4776, thresholdLon: -0.4614 }

describe('visualApproachLegs', () => {
  it('puts the join point 10 nm from the threshold and ends on the threshold itself', () => {
    const [join, threshold] = visualApproachLegs(EGLL_27R)

    expect(VISUAL_JOIN_DISTANCE_NM).toBe(10)
    expect(join!.fixIdent).toBe('27R/10')
    expect(threshold).toEqual(expect.objectContaining({ fixIdent: 'RW27R', fixType: 'R', fixLatitude: 51.4776, fixLongitude: -0.4614 }))
    expect(haversineM(join!.fixLatitude, join!.fixLongitude, 51.4776, -0.4614)).toBeCloseTo(18520, -2)
    // Landing on 270 means the aircraft comes from the east: the join point is east of the threshold.
    expect(join!.fixLongitude).toBeGreaterThan(-0.4614)
  })

  it('works in the southern hemisphere on a different heading (YSSY 16R, true heading ~155)', () => {
    const yssy: VisualRunwayEnd = { ident: '16R', headingTrueDeg: 155, thresholdLat: -33.9461, thresholdLon: 151.1772 }
    const join = visualApproachLegs(yssy)[0]!

    expect(haversineM(join.fixLatitude, join.fixLongitude, yssy.thresholdLat, yssy.thresholdLon)).toBeCloseTo(18520, -2)
    // Reciprocal of 155 is 335: north-north-west of the threshold, i.e. lat increases (less negative), lon decreases.
    expect(join.fixLatitude).toBeGreaterThan(yssy.thresholdLat)
    expect(join.fixLongitude).toBeLessThan(yssy.thresholdLon)
  })

  it('wraps a join point that would land past the antimeridian back into -180..180', () => {
    // Runway just west of 180° landing on 270: the join point is east of it, across the line.
    const fiji: VisualRunwayEnd = { ident: '27', headingTrueDeg: 270, thresholdLat: -17.0, thresholdLon: 179.95 }
    const join = visualApproachLegs(fiji)[0]!

    expect(join.fixLongitude).toBeGreaterThanOrEqual(-180)
    expect(join.fixLongitude).toBeLessThan(-179)
    expect(haversineM(join.fixLatitude, join.fixLongitude, fiji.thresholdLat, fiji.thresholdLon)).toBeCloseTo(18520, -2)
  })
})

describe('visualApproachOptions', () => {
  const runways: VisualRunwayEnd[] = [EGLL_27R, { ident: '09L', headingTrueDeg: 90, thresholdLat: 51.4775, thresholdLon: -0.4826 }]

  it('offers one Visual option per runway end, each with the Vectors transition', () => {
    expect(visualApproachOptions(runways, null)).toEqual([
      { identifier: 'Visual 27R', transition: 'Vectors' },
      { identifier: 'Visual 09L', transition: 'Vectors' }
    ])
  })

  it('narrows to a single runway when one is given, and to nothing for an unknown one', () => {
    expect(visualApproachOptions(runways, '09L')).toEqual([{ identifier: 'Visual 09L', transition: 'Vectors' }])
    expect(visualApproachOptions(runways, '99X')).toEqual([])
  })
})
