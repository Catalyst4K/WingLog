import type { NavdataTaxiSegment } from '@shared/ipc'
import { describe, expect, it } from 'vitest'
import { chooseLine, findTaxiPath, matchClearance, traceWithFallback } from './fallback'
import {
  MAX_CLEARANCE_TAXIWAYS,
  traceTaxiRoute,
  type TaxiTraceRequest,
  type TracedRoute
} from './route-trace'
import REPLAY_227 from './__fixtures__/zjsy-227-taxi-out.json'
import REPLAY_253 from './__fixtures__/zjsy-253-taxi-out.json'
import ZJSY_RAW from './__fixtures__/zjsy-taxi-d-b7-a.json'

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

  it('prefers the taxiway the clearance names where two ways to a stand are equally long', () => {
    const stand = { lat: 29.715, lon: 106.6598 }
    const viaG = findTaxiPath(request({ taxiways: ['M', 'G'], holdingPoint: null, stand }))
    expect(viaG).toContainEqual(lonLat(P3))
    const viaW = findTaxiPath(request({ taxiways: ['M', 'W'], holdingPoint: null, stand }))
    expect(viaW).not.toContainEqual(lonLat(P3))
    expect(viaW?.at(-2)).toEqual(lonLat(P4))
  })

  it('ends a holding-point route where the trace ends one, so the two lines enter the runway at the same hold (EGLL A1, YBBN A9)', () => {
    // The same rules decide where the route ends (a hold short by the runway, a far end, a hold short part-way along): the pathfinder
    // uses the trace's own, needing only the holding point's taxiway.
    const req = request({ taxiways: ['M', 'G', 'H1'], holdingPoint: 'H1' })
    expect(findTaxiPath(req)).toEqual(traceTaxiRoute({ ...req, taxiways: ['H1'] }))
    expect(findTaxiPath(req)?.at(-1)).toEqual(traceTaxiRoute(req)?.at(-1) ?? lonLat(P5))
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

  it('traces on past a cleared taxiway the data lacks, and says it is absent', () => {
    const withoutW = NETWORK.filter((s) => s.name !== 'W')
    const traced = traceWithFallback(request({ segments: withoutW, taxiways: ['Q', 'G', 'H1'] }))
    expect(traced?.kind).toBe('exact')
    expect(traced?.route[0]).toEqual(lonLat(P0))
    expect(traced?.route.at(-1)).toEqual(lonLat(P5))
    expect(traced?.match).toEqual({ absent: ['Q'], notFollowed: [] })
  })

  it('falls back to the pathfinder when a cleared taxiway part-way through is in the data but nowhere the route can reach, and says what did not match', () => {
    // Q is a piece of taxiway on its own, joined to nothing. (A first taxiway like that is joined past, from the start.)
    const island = seg([29.7, 106.7], [29.7005, 106.7], 'Q')
    const withoutW = [...NETWORK.filter((s) => s.name !== 'W'), island]
    const fallback = traceWithFallback(request({ segments: withoutW, taxiways: ['G', 'Q', 'H1'] }))
    expect(fallback?.kind).toBe('pathfinder')
    expect(fallback?.route[0]).toEqual(lonLat(P0))
    expect(fallback?.route.at(-1)).toEqual(lonLat(P5))
    expect(fallback?.match).toEqual({ absent: [], notFollowed: ['Q'] })
  })

  it('has nothing when neither way works', () => {
    expect(traceWithFallback(request({ from: { lat: 30, lon: 107 } }))).toBeNull()
  })
})

// The whole of ZJSY (MSFS facility data from WingLog's cache). Rows: [startLat, startLon, endLat, endLon, name, startHoldShort,
// endHoldShort]. The two replays are flights 227 and 253's taxi out, rows [t, lat, lon, headingDeg, groundSpeedMs, phase].
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
type Sample = [number, number, number, number, number, string]

describe('chooseLine', () => {
  const line = (...problems: ('sharp-turn' | 'misses-end' | 'starts-behind-nose')[]) => ({
    route: [] as TracedRoute,
    problems
  })

  it('keeps the traced line when it passes, whatever the shortest way is', () => {
    expect(chooseLine(line(), line())).toBe('exact')
    expect(chooseLine(line(), null)).toBe('exact')
  })

  it('takes the shortest way when the traced line has a problem and it has fewer', () => {
    expect(chooseLine(line('sharp-turn'), line())).toBe('pathfinder')
    expect(chooseLine(line('sharp-turn', 'misses-end'), line('misses-end'))).toBe('pathfinder')
  })

  it('keeps the traced line when the shortest way is no better: equal problems, or more', () => {
    expect(chooseLine(line('starts-behind-nose'), line('starts-behind-nose'))).toBe('exact')
    expect(chooseLine(line('starts-behind-nose'), line('sharp-turn', 'starts-behind-nose'))).toBe('exact')
    expect(chooseLine(line('sharp-turn'), null)).toBe('exact')
  })

  it('draws the shortest way even with problems when there is no traced line, and nothing when there is neither', () => {
    expect(chooseLine(null, line('sharp-turn'))).toBe('pathfinder')
    expect(chooseLine(null, null)).toBeNull()
  })
})

describe('traceWithFallback on the real ZJSY clearance "via D, A3, A" to holding point A', () => {
  const cleared = { segments: ZJSY, taxiways: ['D', 'A3', 'A'], holdingPoint: 'A' }
  const at = (samples: Sample[]) => {
    const [, lat, lon, headingDeg] = samples[0]
    return { from: { lat, lon }, headingDeg }
  }

  it("draws the shortest way when the traced line would start behind the nose (flight 253's start, nose to the west)", () => {
    const result = traceWithFallback({ ...cleared, ...at(REPLAY_253 as Sample[]) })!
    expect(result.kind).toBe('pathfinder')
    expect(result.problems).toEqual([])
    expect(result.exactProblems).toEqual(['starts-behind-nose'])
  })

  it('keeps the traced line, and says what is wrong with it, when the shortest way is no better (flight 227)', () => {
    const result = traceWithFallback({ ...cleared, ...at(REPLAY_227 as Sample[]) })!
    expect(result.kind).toBe('exact')
    expect(result.problems).toEqual(['starts-behind-nose'])
    expect(result.exactProblems).toEqual(['starts-behind-nose'])
  })

  it('draws the traced line, with nothing wrong, when the aircraft is on D and the heading is unknown', () => {
    const result = traceWithFallback({
      ...cleared,
      taxiways: ['D', 'B7', 'A'],
      from: { lat: 18.3074072, lon: 109.4093493 }
    })!
    expect(result.kind).toBe('exact')
    expect(result.problems).toEqual([])
    expect(result.exactProblems).toEqual([])
  })

  it('draws nothing when there is no network to trace through', () => {
    expect(traceWithFallback({ ...cleared, segments: [], from: { lat: 18.3, lon: 109.4 } })).toBeNull()
  })
})

describe('traceWithFallback guards', () => {
  const onD = { lat: 18.3074072, lon: 109.4093493 }
  const cleared = { segments: ZJSY, taxiways: ['D', 'B7', 'A'], holdingPoint: 'A', from: onD }

  it('draws nothing for a clearance of more than 20 taxiways, however it is built', () => {
    const long = Array.from({ length: MAX_CLEARANCE_TAXIWAYS + 1 }, (_, i) => (i % 2 ? 'A' : 'D'))
    expect(traceWithFallback({ ...cleared, taxiways: long })).toBeNull()
    expect(traceTaxiRoute({ ...cleared, taxiways: long })).toBeNull()
    expect(findTaxiPath({ ...cleared, taxiways: long })).toBeNull()
    expect(
      traceWithFallback({ ...cleared, taxiways: long.slice(0, MAX_CLEARANCE_TAXIWAYS - 17) })
    ).not.toBeNull()
  })

  it('gives up when the search takes more states than its budget, and does not when it has them', () => {
    expect(traceWithFallback(cleared)).not.toBeNull()
    expect(traceWithFallback({ ...cleared, budget: { left: 50 } })).toBeNull()
    expect(traceTaxiRoute({ ...cleared, budget: { left: 50 } })).toBeNull()
  })

  it('shares one budget between the traced line and the shortest way', () => {
    const budget = { left: 100_000 }
    traceWithFallback({ ...cleared, budget })
    expect(budget.left).toBeLessThan(100_000)
  })
})
