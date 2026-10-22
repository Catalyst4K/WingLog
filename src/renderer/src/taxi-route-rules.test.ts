import { describe, expect, it } from 'vitest'
import type { NavdataTaxiSegment } from '@shared/ipc'
import {
  angleBetweenDeg,
  buildGraph,
  startNodes,
  taxiwayUnder,
  traceTaxiRoute,
  type RunwayStrip,
  type TaxiTraceRequest,
  type TracedRoute
} from './taxi-route-trace'
import VHHH_253_RAW from './__fixtures__/vhhh-taxi-253-c7-c-d-c-f-hold-07c.json'
import VHHH_253_SECOND_RAW from './__fixtures__/vhhh-taxi-253-f7-a-b-w.json'
import VHHH_238_RAW from './__fixtures__/vhhh-taxi-238-u-v-h-j.json'
import EGCC_243_RAW from './__fixtures__/egcc-taxi-243-on-bz.json'
import YBBN_225_RAW from './__fixtures__/ybbn-225-taxi-network.json'
import VHHH_227_RAW from './__fixtures__/vhhh-taxi-227-c7-y-f-cross-07c.json'
import { crossingHolds } from './taxi-runway-crossing'

// The taxi routing rules (winglog-backend's docs/plans/taxi-routing-rules.md), each on the real taxi it was worked out from: MSFS
// facility data from WingLog's navdata cache, trimmed to 250 m either side of the taxi. Rows: [startLat, startLon, endLat, endLon,
// name, startHoldShort, endHoldShort]. Starts and headings are the recorded aircraft's when the clearance arrived.
type Row = [number, number, number, number, string | null, number, number]
const toSegments = (rows: unknown): NavdataTaxiSegment[] =>
  (rows as Row[]).map(([startLat, startLon, endLat, endLon, name, startHoldShort, endHoldShort]) => ({
    startLat,
    startLon,
    endLat,
    endLon,
    name,
    startHoldShort: startHoldShort === 1,
    endHoldShort: endHoldShort === 1
  }))

const VHHH_253 = toSegments(VHHH_253_RAW)
const VHHH_253_SECOND = toSegments(VHHH_253_SECOND_RAW)
const VHHH_238 = toSegments(VHHH_238_RAW)
const EGCC_243 = toSegments(EGCC_243_RAW)
const YBBN_225 = toSegments(YBBN_225_RAW)
const VHHH_227 = toSegments(VHHH_227_RAW)

const RUNWAY_07C: RunwayStrip = {
  thresholdLat: 22.309533893514097,
  thresholdLon: 113.89360537645355,
  headingTrueDeg: 70.8878173828125,
  lengthM: 4223.220703125,
  widthM: 60.316253662109375
}

function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  return Math.hypot((a.lat - b.lat) * 111_320, (a.lon - b.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180))
}

const at = ([lon, lat]: [number, number]): { lat: number; lon: number } => ({ lat, lon })

function bearingDeg(a: [number, number], b: [number, number]): number {
  const dx = (b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180)
  return ((Math.atan2(dx, b[1] - a[1]) * 180) / Math.PI + 360) % 360
}

/** The taxiways a route drives along, in order, each with how far: runs of one name collapsed, unnamed segments left out. */
function runsDriven(segments: NavdataTaxiSegment[], route: TracedRoute): { name: string; m: number }[] {
  const nameOf = new Map<string, string | null>()
  const key = (lat: number, lon: number): string => `${lat},${lon}`
  for (const s of segments) {
    nameOf.set(`${key(s.startLat, s.startLon)}|${key(s.endLat, s.endLon)}`, s.name)
    nameOf.set(`${key(s.endLat, s.endLon)}|${key(s.startLat, s.startLon)}`, s.name)
  }
  const runs: { name: string; m: number }[] = []
  for (let i = 1; i < route.length; i++) {
    const [aLon, aLat] = route[i - 1]!
    const [bLon, bLat] = route[i]!
    const name = nameOf.get(`${key(aLat, aLon)}|${key(bLat, bLon)}`)
    if (!name) continue
    const m = distanceM({ lat: aLat, lon: aLon }, { lat: bLat, lon: bLon })
    const last = runs.at(-1)
    if (last?.name === name) last.m += m
    else runs.push({ name, m })
  }
  return runs
}

/** The sharpest turn a route makes at any one point, in degrees. */
function sharpestTurnDeg(route: TracedRoute): number {
  let sharpest = 0
  for (let i = 2; i < route.length; i++) {
    const turn = angleBetweenDeg(
      bearingDeg(route[i - 2]!, route[i - 1]!),
      bearingDeg(route[i - 1]!, route[i]!)
    )
    sharpest = Math.max(sharpest, turn)
  }
  return sharpest
}

/** Whether a route passes through the same point twice. */
function revisitsAPoint(route: TracedRoute): boolean {
  return new Set(route.map(([lon, lat]) => `${lon},${lat}`)).size < route.length
}

describe('VHHH flight 253 arrival, "taxi via C7, C, D, C, F, hold short of runway 07C" (2026-10-21)', () => {
  const request: TaxiTraceRequest = {
    segments: VHHH_253,
    taxiways: ['C7', 'C', 'D', 'C', 'F'],
    holdingPoint: 'F',
    from: { lat: 22.326788509773923, lon: 113.90186887003257 },
    headingDeg: 100.66584392336691,
    holdShortRunway: RUNWAY_07C
  }
  const route = traceTaxiRoute(request)!
  const runs = runsDriven(VHHH_253, route)

  it('takes a link onto D early and drives D, the inside of the bend, the long way: as flight 250 drove "D, C, F"', () => {
    // Before, the line stayed on C (the outside of the bend) for 2.7 km and found a D on the roundabout's arcs at the far end.
    const names = runs.map((r) => r.name)
    expect(names.slice(0, 2)).toEqual(['C7', 'C'])
    const d = runs.find((r) => r.name === 'D')!
    expect(d.m).toBeGreaterThan(2000)
    expect(runs.slice(0, names.indexOf('D')).reduce((m, r) => m + r.m, 0)).toBeLessThan(1000)
  })

  it('goes through the roundabout on its C arcs onto F, not across by E and F7, with no hairpin and never the same place twice', () => {
    const names = runs.map((r) => r.name)
    expect(names.slice(names.indexOf('D'))).toEqual(['D', 'C', 'F', 'F7'])
    expect(names).not.toContain('E')
    expect(sharpestTurnDeg(route)).toBeLessThanOrEqual(100)
    expect(revisitsAPoint(route)).toBe(false)
  })

  it('starts on the curve ahead of the nose (east), not the one 16 m off to the side (west, a 164° turn back)', () => {
    const first = route[0]!
    expect(distanceM(request.from, at(first))).toBeLessThan(40)
    expect(
      angleBetweenDeg(bearingDeg([request.from.lon, request.from.lat], first), request.headingDeg!)
    ).toBeLessThan(90)
  })

  it('ends at the hold short beside 07C on F7, where Callum held, not one beside another runway or further along F', () => {
    const end = at(route.at(-1)!)
    // Where the aircraft stopped for the hold, the start of the next clearance.
    expect(distanceM(end, { lat: 22.321479100689785, lon: 113.92706019806538 })).toBeLessThan(30)
  })
})

describe('VHHH flight 227 arrival, "taxi via C7, Y, F, hold short of runway 07C"', () => {
  const route = traceTaxiRoute({
    segments: VHHH_227,
    taxiways: ['C7', 'Y', 'F'],
    holdingPoint: 'F',
    from: { lat: 22.326749153608112, lon: 113.90214962211722 },
    headingDeg: 110.45889075430183,
    holdShortRunway: RUNWAY_07C
  })!

  it('holds short where the route crosses 07C (F2, near its end), not on the high-speed exit F4 beside Y (Callum, 2026-10-22)', () => {
    const names = runsDriven(VHHH_227, route).map((r) => r.name)
    expect(names).toEqual(['C7', 'Y', 'F', 'F2'])
    // F2's hold short, straight across 07C from A2's.
    expect(distanceM(at(route.at(-1)!), { lat: 22.311993766590778, lon: 113.89814976025207 })).toBeLessThan(1)
  })

  it('finds the crossings near both ends of 07C and none of its exits', () => {
    const graph = buildGraph(VHHH_227, 22.32)
    const names = [...crossingHolds(graph, RUNWAY_07C)].flatMap((n) =>
      graph.edges[n]!.map((e) => e.name).filter((name) => name !== null)
    )
    expect(names).toContain('F2')
    expect(names).not.toContain('F3')
    expect(names).not.toContain('F4')
  })
})

describe('VHHH flight 238 departure, "taxi to holding point J1 via U, V, H, J" (driven as cleared)', () => {
  const route = traceTaxiRoute({
    segments: VHHH_238,
    taxiways: ['U', 'V', 'H', 'J'],
    holdingPoint: 'J1',
    from: { lat: 22.311464131412354, lon: 113.9190729998079 },
    headingDeg: 340.88420951999984,
    runwayThreshold: { lat: 22.296249133289006, lon: 113.89808801544805, headingDeg: 70.88046264648438 }
  })!

  it('goes the way the nose points and onto V by the link U1, which the clearance leaves out', () => {
    const names = runsDriven(VHHH_238, route).map((r) => r.name)
    expect(names.slice(0, 3)).toEqual(['U', 'U1', 'V'])
  })

  it('joins J at the first link, H6, and drives J the rest of the way, as Callum did (H 89 m, H6 214 m, J 1.9 km)', () => {
    // Before, the line stayed on H, the parallel taxiway, to the far end.
    const runs = runsDriven(VHHH_238, route)
    const names = runs.map((r) => r.name)
    const h = names.indexOf('H')
    expect(names.slice(h, h + 3)).toEqual(['H', 'H6', 'J'])
    expect(runs[h]!.m).toBeLessThan(200)
    expect(runs[h + 2]!.m).toBeGreaterThan(1500)
  })
})

describe('VHHH flight 253, the second clearance, "taxi to Ramp W122 via F7, A, B, W", given at F7\'s hold short', () => {
  const stand = { lat: 22.311448218277512, lon: 113.92381595183745 }
  const route = traceTaxiRoute({
    segments: VHHH_253_SECOND,
    taxiways: ['F7', 'A', 'B', 'W'],
    holdingPoint: null,
    from: { lat: 22.321479100689785, lon: 113.92706019806538 },
    headingDeg: 157.46147386143994,
    stand
  })!

  it('goes on from F7, where the aircraft already is, not back round to drive it', () => {
    const names = runsDriven(VHHH_253_SECOND, route).map((r) => r.name)
    expect(names).not.toContain('F7')
    expect(names.filter((n) => ['A', 'B', 'W'].includes(n))).toEqual(['A', 'B', 'W'])
    expect(revisitsAPoint(route)).toBe(false)
  })

  it('ends at the ramp', () => {
    expect(at(route.at(-1)!)).toEqual(stand)
  })
})

describe('EGCC flight 243, the whole clearance again once on BZ: "taxi to stand 211 via VC, V, U, BZ, B, A, D, E, NA"', () => {
  const route = traceTaxiRoute({
    segments: EGCC_243,
    taxiways: ['VC', 'V', 'U', 'BZ', 'B', 'A', 'D', 'E', 'NA'],
    holdingPoint: null,
    from: { lat: 53.34920610185424, lon: -2.279821278656368 },
    headingDeg: 32.02758870949203,
    stand: { lat: 53.366463007176904, lon: -2.286252857573074 }
  })!

  it('picks the clearance up at BZ, not 541 m back along VC', () => {
    const names = runsDriven(EGCC_243, route).map((r) => r.name)
    expect(names[0]).toBe('BZ')
    expect(names).not.toContain('VC')
    expect(names.filter((n) => ['B', 'A', 'D', 'E', 'NA'].includes(n))).toEqual(['B', 'A', 'D', 'E', 'NA'])
  })
})

describe('YBBN flight 225 departure, "taxi to holding point A9 via C9, B9", pushed back facing away from C9', () => {
  const route = traceTaxiRoute({
    segments: YBBN_225,
    taxiways: ['C9', 'B9'],
    holdingPoint: 'A9',
    from: { lat: -27.402681391156552, lon: 153.1128160761545 },
    headingDeg: 210.95381974587798
  })!

  it('joins the clearance at B9 the way the nose points, as Callum did by C10 and B, not past B9 and round the block to drive C9', () => {
    const names = runsDriven(YBBN_225, route).map((r) => r.name)
    expect(names).toEqual(['C10', 'B', 'B9', 'A9'])
    expect(revisitsAPoint(route)).toBe(false)
  })
})

// A small made-up network, in metres east and north of a point at VHHH's latitude.
const pt = (eastM: number, northM: number): [number, number] => [
  22.3 + northM / 111_320,
  113.9 + eastM / (111_320 * Math.cos((22.3 * Math.PI) / 180))
]
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
const lonLat = (p: [number, number]): [number, number] => [p[1], p[0]]

describe('sharp turns', () => {
  // T runs east. U's short way to its hold short (P2) leaves T at P1 turning 160° back; the long way round turns 90°, 90° and 43°.
  const P0 = pt(0, 0)
  const P1 = pt(100, 0)
  const P2 = pt(25, -27)
  const P3 = pt(160, 0)
  const P4 = pt(160, -60)
  const P5 = pt(60, -60)
  const sharp = seg(P1, P2, 'U', true)
  const roundabout = [seg(P1, P3, 'T'), seg(P3, P4, null), seg(P4, P5, null), seg(P5, P2, 'U', true)]
  const request = (segments: NavdataTaxiSegment[]): TaxiTraceRequest => ({
    segments: [seg(P0, P1, 'T'), ...segments],
    taxiways: ['T'],
    holdingPoint: 'U',
    from: { lat: P0[0], lon: P0[1] },
    headingDeg: 90
  })

  it('goes the long way round rather than turn more than an airliner can at one point', () => {
    expect(traceTaxiRoute(request([sharp, ...roundabout]))).toEqual([P0, P1, P3, P4, P5, P2].map(lonLat))
  })

  it('still takes the sharp turn when there is no other way', () => {
    expect(traceTaxiRoute(request([sharp]))).toEqual([P0, P1, P2].map(lonLat))
  })
})

describe('crossingHolds', () => {
  // A runway running east, 60 m wide, centreline on y = 0. A taxiway crosses it straight at x = 500 between hold shorts 100 m either
  // side; at x = 1500 an exit runs from a hold short 100 m north to the centreline at a 30° angle, and another from the south to the
  // same point, so the two connect, but only by a way about twice the straight line between them.
  const runway: RunwayStrip = {
    thresholdLat: 22.3,
    thresholdLon: 113.9,
    headingTrueDeg: 90,
    lengthM: 3000,
    widthM: 60
  }
  const hold = (a: [number, number], b: [number, number]): NavdataTaxiSegment => ({
    ...seg(a, b, null),
    startHoldShort: true
  })
  const graph = buildGraph(
    [
      hold(pt(500, 100), pt(500, 0)),
      hold(pt(500, -100), pt(500, 0)),
      hold(pt(1500, 100), pt(1673, 0)),
      hold(pt(1500, -100), pt(1673, 0))
    ],
    22.3
  )

  it('is the hold shorts a taxiway joins straight across the runway, not those of exits that only meet at it', () => {
    const crossings = [...crossingHolds(graph, runway)].map((n) => [graph.nodes[n]!.lat, graph.nodes[n]!.lon])
    expect(crossings).toHaveLength(2)
    expect(crossings).toEqual(expect.arrayContaining([pt(500, 100), pt(500, -100)]))
  })
})

describe('turning round in a few metres', () => {
  // T runs east; the hold short (Q2) is back west on U, 10 m south of T. Turning right twice, 10 m apart, onto U is two 90° turns
  // (neither sharp at its own point, but 180° in 10 m, a turn on the spot). The drivable way goes on 200 m and round by two turns 80 m
  // apart.
  const P0 = pt(0, 0)
  const P1 = pt(100, 0)
  const Q1 = pt(100, -10)
  const Q2 = pt(0, -10)
  const P3 = pt(300, 0)
  const P4 = pt(300, -80)
  const P5 = pt(120, -10)
  const request: TaxiTraceRequest = {
    segments: [
      seg(P0, P1, 'T'),
      seg(P1, Q1, null),
      seg(Q1, Q2, 'U', true),
      seg(P1, P3, 'T'),
      seg(P3, P4, null),
      seg(P4, P5, null),
      seg(P5, Q1, 'U')
    ],
    taxiways: ['T'],
    holdingPoint: 'U',
    from: { lat: P0[0], lon: P0[1] },
    headingDeg: 90
  }

  it('goes round the drivable way rather than turn 180° in 10 m, though no one point turns more than 90°', () => {
    expect(traceTaxiRoute(request)).toEqual([P0, P1, P3, P4, P5, Q1, Q2].map(lonLat))
  })
})

describe('taxiwayUnder', () => {
  const graph = buildGraph([seg(pt(0, 0), pt(200, 0), 'T'), seg(pt(100, 0), pt(100, -150), 'X')], 22.3)
  const [lat, lon] = pt(50, 3)

  it('is the taxiway the aircraft is driving along, either way', () => {
    expect(taxiwayUnder(graph, { lat, lon }, 85)).toBe('T')
    expect(taxiwayUnder(graph, { lat, lon }, 270)).toBe('T')
  })

  it('is nothing when the aircraft is crossing it, or nowhere near one', () => {
    expect(taxiwayUnder(graph, { lat, lon }, 0)).toBeNull()
    const [farLat, farLon] = pt(50, 60)
    expect(taxiwayUnder(graph, { lat: farLat, lon: farLon }, 90)).toBeNull()
  })
})

describe('startNodes', () => {
  // A fork just ahead of the aircraft: the point nearest it is off to its side, a little behind.
  const side = pt(-3, -12)
  const ahead = pt(25, 0)
  const graph = buildGraph([seg(side, pt(-60, -40), 'W'), seg(ahead, pt(120, 0), 'E')], 22.3)
  const [lat, lon] = pt(0, 0)

  it('is every point within 40 m ahead of the nose', () => {
    const starts = startNodes(graph, { lat, lon }, 90)
    expect(starts.map((s) => graph.nodes[s.node]).map((n) => [n!.lat, n!.lon])).toEqual([ahead])
    expect(starts[0]!.distanceM).toBeCloseTo(25, 0)
  })

  it('is the nearest point with nothing ahead, or with no heading', () => {
    const facingAway = startNodes(graph, { lat, lon }, 315)
    expect(facingAway.map((s) => graph.nodes[s.node]).map((n) => [n!.lat, n!.lon])).toEqual([side])
    expect(facingAway[0]!.distanceM).toBe(0)
    expect(startNodes(graph, { lat, lon }, null).map((s) => s.distanceM)).toEqual([0])
  })
})
