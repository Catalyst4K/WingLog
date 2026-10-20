import type { NavdataTaxiSegment } from '@shared/ipc'
import { describe, expect, it } from 'vitest'
import { findTaxiPath, matchClearance, traceWithFallback } from './taxi-fallback'
import type { TaxiTraceRequest } from './taxi-route-trace'

const seg = (
  a: [number, number],
  b: [number, number],
  name: string | null,
  endHoldShort = false
): NavdataTaxiSegment => ({
  startLat: a[0],
  startLon: a[1],
  endLat: b[0],
  endLon: b[1],
  name,
  startHoldShort: false,
  endHoldShort
})

// A ZUCK-shaped airport: the apron (M2, M1), the parallel taxiway G, then H1 to a hold short beside the runway. W is a second way
// from the end of M1 to the start of H1, exactly as long as G.
const P0: [number, number] = [29.727, 106.655]
const P1: [number, number] = [29.7275, 106.6556]
const P2: [number, number] = [29.7275, 106.66]
const P3: [number, number] = [29.72, 106.66]
const P4: [number, number] = [29.715, 106.66]
const P5: [number, number] = [29.715, 106.662]
const NETWORK = [
  seg(P0, P1, 'M2'),
  seg(P1, P2, 'M1'),
  seg(P2, P3, 'G'),
  seg(P3, P4, 'G'),
  seg(P2, P4, 'W'),
  seg(P4, P5, 'H1', true)
]

const request = (over: Partial<TaxiTraceRequest> = {}): TaxiTraceRequest => ({
  segments: NETWORK,
  taxiways: ['M', 'G', 'H1'],
  holdingPoint: 'H1',
  from: { lat: P0[0], lon: P0[1] },
  ...over
})
const lonLat = (p: [number, number]): [number, number] => [p[1], p[0]]
const names = (req: TaxiTraceRequest, route: [number, number][] | null): string[] =>
  route ? matchClearance(req, route).notFollowed : []

describe('findTaxiPath', () => {
  it('finds the way from the aircraft to the holding point when the cleared M is not in the data', () => {
    const route = findTaxiPath(request())
    expect(route?.[0]).toEqual(lonLat(P0))
    expect(route?.at(-1)).toEqual(lonLat(P5))
  })

  it('prefers the taxiway the clearance names where two ways are equally long', () => {
    expect(findTaxiPath(request({ taxiways: ['G'], holdingPoint: 'H1' }))).toContainEqual(lonLat(P3))
    const viaW = findTaxiPath(request({ taxiways: ['W'], holdingPoint: 'H1' }))
    expect(viaW).not.toContainEqual(lonLat(P3))
    expect(viaW?.at(-1)).toEqual(lonLat(P5))
  })

  it('ends at the hold short by the cleared runway when the holding point is not in the data at all', () => {
    const route = findTaxiPath(
      request({
        taxiways: ['G'],
        holdingPoint: 'Q9',
        runwayThreshold: { lat: P5[0], lon: P5[1] + 0.0005 }
      })
    )
    expect(route?.at(-1)).toEqual(lonLat(P5))
  })

  it('goes on to the hold short at the very start of the runway when the holding point is not in the data, past one reached first', () => {
    // A second entry 72 m along the runway (P6), with the aircraft right beside it: the full-length departure's hold short is P5.
    const P6: [number, number] = [29.715, 106.6637]
    const route = findTaxiPath(
      request({
        segments: [...NETWORK, seg(P5, P6, 'H2', true)],
        from: { lat: P6[0], lon: P6[1] },
        taxiways: ['G'],
        holdingPoint: 'Q9',
        // The runway's centreline 22 m north of the hold shorts, so both are on the same side of it.
        runwayThreshold: { lat: P5[0] + 0.0002, lon: P5[1] + 0.0005, headingDeg: 90 }
      })
    )
    expect(route?.[0]).toEqual(lonLat(P6))
    expect(route?.at(-1)).toEqual(lonLat(P5))
  })

  it('has nowhere to go for a holding point that is not in the data, with no runway to say where', () => {
    expect(findTaxiPath(request({ holdingPoint: 'Q9' }))).toBeNull()
  })

  it('ends at the hold short beside the runway of a hold short of runway clearance', () => {
    const route = findTaxiPath(
      request({
        taxiways: ['M', 'G'],
        holdingPoint: 'G',
        holdShortRunway: {
          thresholdLat: P5[0],
          thresholdLon: P5[1] + 0.0005,
          headingTrueDeg: 90,
          lengthM: 3000,
          widthM: 45
        }
      })
    )
    expect(route?.at(-1)).toEqual(lonLat(P5))
  })

  it('goes to the stand, and on to the stand itself, for a stand clearance', () => {
    const stand = { lat: 29.7276, lon: 106.6595 }
    const route = findTaxiPath(request({ taxiways: ['M', 'G'], holdingPoint: null, stand }))
    expect(route?.at(-2)).toEqual(lonLat(P2))
    expect(route?.at(-1)).toEqual([stand.lon, stand.lat])
  })

  it('has no destination for a clearance with nothing to say where it ends', () => {
    expect(findTaxiPath(request({ taxiways: [], holdingPoint: null }))).toBeNull()
    expect(
      findTaxiPath(
        request({ taxiways: [], holdingPoint: null, runwayThreshold: { lat: P5[0], lon: P5[1] + 0.0005 } })
      )
    ).toBeNull()
  })

  it('finds nothing for an aircraft off the network, or with no destination to head for', () => {
    expect(findTaxiPath(request({ from: { lat: 30, lon: 107 } }))).toBeNull()
    expect(findTaxiPath(request({ taxiways: [], holdingPoint: null }))).toBeNull()
  })
})

describe('matchClearance', () => {
  it('lists the cleared taxiways the data lacks, and those it has that the line does not follow', () => {
    const route = [P0, P1, P2, P4, P5].map(lonLat)
    // The line goes M2, M1, W, H1: G is in the data but not followed, M is not in the data at all.
    expect(matchClearance(request(), route)).toEqual({ absent: ['M'], notFollowed: ['G'] })
  })

  it('wants the cleared taxiways in the order cleared', () => {
    const route = [P0, P1, P2, P3, P4, P5].map(lonLat)
    expect(names(request({ taxiways: ['H1', 'G'], holdingPoint: null }), route)).toEqual(['G'])
    expect(matchClearance(request({ taxiways: ['G', 'H1'], holdingPoint: null }), route)).toEqual({
      absent: [],
      notFollowed: []
    })
  })
})

describe('traceWithFallback', () => {
  it('traces through the cleared taxiways when it can', () => {
    const exact = traceWithFallback(request({ taxiways: ['M2', 'M1', 'G', 'H1'] }))
    expect(exact?.kind).toBe('exact')
    expect(exact?.match).toEqual({ absent: [], notFollowed: [] })
  })

  it('falls back to the pathfinder when a cleared taxiway is in the data nowhere near the aircraft route, and says what did not match', () => {
    const fallback = traceWithFallback(request({ taxiways: ['Q', 'G', 'H1'] }))
    expect(fallback?.kind).toBe('pathfinder')
    expect(fallback?.route[0]).toEqual(lonLat(P0))
    expect(fallback?.route.at(-1)).toEqual(lonLat(P5))
    expect(fallback?.match).toEqual({ absent: ['Q'], notFollowed: [] })
  })

  it('has nothing when neither way works', () => {
    expect(traceWithFallback(request({ from: { lat: 30, lon: 107 } }))).toBeNull()
  })
})
