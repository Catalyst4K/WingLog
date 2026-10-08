import { describe, expect, it } from 'vitest'
import type { NavdataStand, NavdataTaxiSegment } from '../../src/shared/ipc'
import { seeded } from '../phase-rules'
import { buildNetwork, checkClearance, generateClearances, type GeneratedClearance } from './airport-rules'

const STEP = 0.001
const LAT0 = 51.4
const LON0 = -0.45

/** A small airport: horizontal taxiways A, B and C, joined by named links V0..V5, with hold shorts at both ends of A and C. */
function gridAirport(): { segments: NavdataTaxiSegment[]; stands: NavdataStand[] } {
  const segments: NavdataTaxiSegment[] = []
  const at = (x: number, y: number): { lat: number; lon: number } => ({
    lat: LAT0 + y * STEP,
    lon: LON0 + x * STEP
  })
  const add = (ax: number, ay: number, bx: number, by: number, name: string, endHold = false): void => {
    const a = at(ax, ay)
    const b = at(bx, by)
    segments.push({
      startLat: a.lat,
      startLon: a.lon,
      endLat: b.lat,
      endLon: b.lon,
      name,
      startHoldShort: false,
      endHoldShort: endHold
    })
  }
  for (const [y, name] of [
    [0, 'A'],
    [1, 'B'],
    [2, 'C']
  ] as const) {
    for (let x = 0; x < 6; x++) add(x, y, x + 1, y, name, x === 5 && y !== 1)
  }
  for (let x = 0; x <= 6; x += 2) {
    add(x, 0, x, 1, `V${x}`)
    add(x, 1, x, 2, `V${x}`)
  }
  const stands: NavdataStand[] = [1, 3, 5].map((x, i) => ({
    name: `S${i + 1}`,
    number: i + 1,
    suffix: 0,
    headingDeg: 0,
    ...at(x, 2.1)
  }))
  return { segments, stands }
}

describe('airport rules', () => {
  const { segments, stands } = gridAirport()
  const network = buildNetwork(segments)
  const made = generateClearances(network, stands, seeded(7), 60)

  it('generates the clearances asked for, of every kind, the same way each time for a seed', () => {
    expect(made).toHaveLength(60)
    expect(new Set(made.map((g) => g.kind))).toEqual(new Set(['holding point', 'runway hold short', 'stand']))
    const again = generateClearances(network, stands, seeded(7), 60)
    expect(again.map((g) => g.clearance.taxiways)).toEqual(made.map((g) => g.clearance.taxiways))
  })

  it('makes clearances from real walks: named taxiways, a start near the aircraft, a stand only for a stand clearance', () => {
    for (const g of made) {
      expect(g.clearance.taxiways.length).toBeGreaterThan(0)
      expect(g.walk.length).toBeGreaterThan(1)
      expect(g.walkM).toBeGreaterThan(100)
      expect(g.kind === 'stand').toBe(g.stand !== null)
    }
  })

  it('finds no failures when the app traces them', () => {
    const failed = made.flatMap((g) => {
      const { failures } = checkClearance(network, segments, g)
      return failures.length > 0 ? [{ clearance: g.clearance, failures }] : []
    })
    expect(failed).toEqual([])
  })

  describe('each rule is caught', () => {
    const hold = made.find((g) => g.kind === 'runway hold short' && g.walk.length > 3) as GeneratedClearance
    const stand = made.find((g) => g.kind === 'stand') as GeneratedClearance
    const rulesOf = (g: GeneratedClearance, trace: Parameters<typeof checkClearance>[3]): string[] =>
      checkClearance(network, segments, g, trace).failures.map((f) => f.rule)

    it('a route that is not found', () => {
      expect(rulesOf(hold, () => null)).toEqual(['traced'])
    })

    it('a route that starts far from the aircraft', () => {
      const far: [number, number][] = [[LON0 + 5 * STEP, LAT0 + 2 * STEP], ...hold.walk.slice(1)]
      const farFrom = { ...hold, clearance: { ...hold.clearance, from: { lat: LAT0 + 0.05, lon: LON0 } } }
      expect(rulesOf(farFrom, () => far)).toContain('starts at the aircraft')
    })

    it('a route that jumps between points that are not joined', () => {
      const jump: [number, number][] = [hold.walk[0], hold.walk[hold.walk.length - 1]]
      expect(rulesOf({ ...hold, walkM: 10_000 }, () => jump)).toContain('connected')
    })

    it('a route that does not follow the cleared taxiways', () => {
      const wrongNames = { ...hold, clearance: { ...hold.clearance, taxiways: ['Q9'] } }
      expect(rulesOf(wrongNames, () => hold.walk)).toContain('follows the names')
    })

    it('a route that stops partway along a taxiway', () => {
      const short = hold.walk.slice(0, 2)
      const partway = { ...hold, clearance: { ...hold.clearance, taxiways: [] as string[] } }
      expect(rulesOf({ ...partway, walkM: 10_000 }, () => short)).toContain('ends right')
    })

    it('a route far longer than the clearance’s own', () => {
      const there = hold.walk
      const back = [...hold.walk].reverse().slice(1)
      const out = [...there, ...back, ...there.slice(1), ...back]
      expect(rulesOf(hold, () => out)).toContain('not too long')
    })

    it('a stand clearance that finishes short of the stand', () => {
      expect(rulesOf(stand, () => stand.walk)).toContain('ends right')
    })

    it('a stand clearance that finishes at the stand passes the end rule', () => {
      const withStand: [number, number][] = [...stand.walk, [stand.stand!.lon, stand.stand!.lat]]
      expect(rulesOf(stand, () => withStand)).not.toContain('ends right')
    })
  })
})
