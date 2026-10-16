import { describe, expect, it } from 'vitest'
import FLIGHT_239 from './__fixtures__/flight-239-gap.json'
import {
  DEFAULT_GAP_FILL,
  estimatedLengthNm,
  fillTrackGaps,
  parseEstimatedStretches,
  pathLengthNm,
  type GapFillPoint
} from './track-gap-fill'
import { parseRouteFromOfpJson } from './ofp-route'

// Flight 239 (EGLL to RKSI, 2026-10-15): its real OFP route (152 fixes) and the recorded points either side of the 400 minute gap
// where a full disk stopped the recording. Coordinates only, rounded: nothing personal.
const ROUTE = FLIGHT_239.route as [number, number][]
const BEFORE = FLIGHT_239.before as GapFillPoint[]
const AFTER = FLIGHT_239.after as GapFillPoint[]

describe('fillTrackGaps', () => {
  it("fills flight 239's 400 minute gap along the plan, from the last point before it to the first after it", () => {
    const stretches = fillTrackGaps([...BEFORE, ...AFTER], ROUTE)
    expect(stretches).toHaveLength(1)
    const [stretch] = stretches
    expect(stretch.fromTsUtc).toBe('2026-10-16T01:49:43.403Z')
    expect(stretch.toTsUtc).toBe(AFTER[0].tsUtc)
    expect(stretch.coordinates[0]).toEqual([BEFORE.at(-1)!.longitude, BEFORE.at(-1)!.latitude])
    expect(stretch.coordinates.at(-1)).toEqual([AFTER[0].longitude, AFTER[0].latitude])
    // The recorded gap is 3,054 nm straight; along the plan it is a little longer, never shorter.
    expect(stretch.lengthNm).toBeGreaterThan(3054)
    expect(stretch.lengthNm).toBeLessThan(3400)
    expect(stretch.lengthNm).toBeCloseTo(pathLengthNm(stretch.coordinates), 6)
    // From where the plan is joined, it runs through the plan's own fixes in order, eastwards. (The first step can go a little back:
    // the recorded point was 1.5 nm off the line, and the shortest way onto it is sideways.)
    const lons = stretch.coordinates.slice(1).map((c) => c[0])
    expect(lons).toEqual([...lons].sort((a, b) => a - b))
    expect(stretch.coordinates.length).toBeGreaterThan(10)
  })

  it('leaves a track with no gap alone', () => {
    expect(fillTrackGaps(BEFORE, ROUTE)).toEqual([])
    expect(fillTrackGaps(AFTER, ROUTE)).toEqual([])
  })

  it('has nothing to follow without a flight plan', () => {
    expect(fillTrackGaps([...BEFORE, ...AFTER], [])).toEqual([])
    expect(fillTrackGaps([...BEFORE, ...AFTER], [[0, 0]])).toEqual([])
  })

  it('does not fill a gap whose ends are far from the plan (a diversion the plan knows nothing about)', () => {
    const wide = BEFORE.map((p) => ({ ...p, latitude: p.latitude + 3 }))
    expect(fillTrackGaps([...wide, ...AFTER], ROUTE)).toEqual([])
    // ...unless the tolerance allows it.
    expect(fillTrackGaps([...wide, ...AFTER], ROUTE, { ...DEFAULT_GAP_FILL, toleranceNm: 400 })).toHaveLength(
      1
    )
  })

  it('does not fill a gap that would run backwards along the plan', () => {
    expect(
      fillTrackGaps([...AFTER, ...BEFORE.map((p) => ({ ...p, tsUtc: '2026-10-16T09:00:00.000Z' }))], ROUTE)
    ).toEqual([])
  })

  it('treats a new recording segment as a gap even when the times are close', () => {
    const a = { tsUtc: '2026-10-16T01:00:00Z', latitude: 44.2125, longitude: 27.6809, resumeSegment: 0 }
    const b = { tsUtc: '2026-10-16T01:00:30Z', latitude: 44.2, longitude: 28.0, resumeSegment: 1 }
    expect(fillTrackGaps([a, b], ROUTE)).toHaveLength(1)
    expect(fillTrackGaps([a, { ...b, resumeSegment: 0 }], ROUTE)).toEqual([])
  })

  it('fills each of two gaps in one flight, and sums them', () => {
    const route: [number, number][] = [
      [0, 50],
      [10, 50],
      [20, 50],
      [30, 50]
    ]
    const at = (min: number, lon: number, seg = 0): GapFillPoint => ({
      tsUtc: new Date(Date.UTC(2026, 9, 1, 0, min)).toISOString(),
      latitude: 50,
      longitude: lon,
      resumeSegment: seg
    })
    const stretches = fillTrackGaps([at(0, 1), at(1, 2), at(60, 12, 1), at(61, 13, 1), at(200, 28, 2)], route)
    expect(stretches).toHaveLength(2)
    expect(estimatedLengthNm(stretches)).toBeCloseTo(stretches[0].lengthNm + stretches[1].lengthNm, 9)
    // The first fill goes 2E to 12E, through the vertex at 10E.
    const lons = stretches[0].coordinates.map((c) => c[0])
    expect(lons).toHaveLength(5)
    lons.forEach((lon, i) => expect(lon).toBeCloseTo([2, 2, 10, 12, 12][i], 9))
  })
})

describe('parseEstimatedStretches', () => {
  it('reads what fillTrackGaps stored', () => {
    const stretches = fillTrackGaps([...BEFORE, ...AFTER], ROUTE)
    expect(parseEstimatedStretches(JSON.stringify(stretches))).toEqual(stretches)
  })

  it('returns nothing for missing or malformed data, and drops a bad stretch but keeps a good one', () => {
    expect(parseEstimatedStretches(null)).toEqual([])
    expect(parseEstimatedStretches('not json')).toEqual([])
    expect(parseEstimatedStretches('{"a":1}')).toEqual([])
    const good = {
      coordinates: [
        [1, 2],
        [3, 4]
      ],
      lengthNm: 10,
      fromTsUtc: 'a',
      toTsUtc: 'b'
    }
    const bad = {
      coordinates: [
        [1, 2],
        [3, 99999]
      ],
      lengthNm: 10
    }
    const text = { coordinates: 'x', lengthNm: 1 }
    expect(parseEstimatedStretches(JSON.stringify([bad, good, text, null]))).toEqual([good])
  })
})

describe('parseRouteFromOfpJson', () => {
  it('reads the navlog fixes and skips any without a position', () => {
    const ofp = JSON.stringify({
      navlog: {
        fix: [{ pos_long: '-0.5', pos_lat: '51.4' }, { pos_long: 'x' }, { pos_long: 126.4, pos_lat: 37.4 }]
      }
    })
    expect(parseRouteFromOfpJson(ofp)).toEqual([
      [-0.5, 51.4],
      [126.4, 37.4]
    ])
    expect(parseRouteFromOfpJson(null)).toEqual([])
    expect(parseRouteFromOfpJson('{')).toEqual([])
  })
})
