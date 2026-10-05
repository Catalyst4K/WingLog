import { describe, expect, it } from 'vitest'
import type { NavdataTaxiSegment } from '@shared/ipc'
import { remainingRoute, traceTaxiRoute } from './taxiRouteTrace'
import VHHH_RAW from './__fixtures__/vhhh-taxi-b8-b10.json'
import VHHH_ARRIVAL_RAW from './__fixtures__/vhhh-taxi-arrival-j-h6-h-v-b.json'
import YBBN_RAW from './__fixtures__/ybbn-taxi-c9-b9-a9.json'
import ZJSY_RAW from './__fixtures__/zjsy-taxi-d-b7-a.json'
import VHHH_HOLD_07C_RAW from './__fixtures__/vhhh-taxi-c7-y-f-hold-07c.json'

// Real taxi networks (MSFS facility data), each trimmed to a box around one real clearance's
// route. Rows: [startLat, startLon, endLat, endLon, name, startHoldShort, endHoldShort].
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
// VHHH, fetched live 2026-09-30: ~1.2 km around the east end of runway 25C.
const VHHH = toSegments(VHHH_RAW)
// YBBN and VHHH from the real YBBN-VHHH flight (2026-10-02), around the departure and arrival taxi routes.
const YBBN = toSegments(YBBN_RAW)
const VHHH_ARRIVAL = toSegments(VHHH_ARRIVAL_RAW)
// The whole airport, so A's far ends are real ends rather than the edge of a trimmed box.
const ZJSY = toSegments(ZJSY_RAW)
const VHHH_HOLD_07C = toSegments(VHHH_HOLD_07C_RAW)

function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  return Math.hypot((a.lat - b.lat) * 111_320, (a.lon - b.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180))
}

/** Which taxiway names a traced route drives along, in order, runs collapsed. */
function namesDriven(segments: NavdataTaxiSegment[], route: [number, number][]): string[] {
  const names: string[] = []
  for (let i = 1; i < route.length; i++) {
    const [aLon, aLat] = route[i - 1]!
    const [bLon, bLat] = route[i]!
    const seg = segments.find(
      (s) =>
        (s.startLat === aLat && s.startLon === aLon && s.endLat === bLat && s.endLon === bLon) ||
        (s.startLat === bLat && s.startLon === bLon && s.endLat === aLat && s.endLon === aLon)
    )
    const name = seg?.name ?? '-'
    if (name !== '-' && names.at(-1) !== name) names.push(name)
  }
  return names
}

// The far (stand) end of B8, and B10's real hold-short point on runway 25C.
const STAND_END_OF_B8 = { lat: 22.3151936, lon: 113.9290456 }
const B10_HOLD_SHORT: [number, number] = [113.9325748, 22.3209537]

function lengthM(route: [number, number][]): number {
  let total = 0
  for (let i = 1; i < route.length; i++) {
    const [lonA, latA] = route[i - 1]!
    const [lonB, latB] = route[i]!
    total += Math.hypot((latA - latB) * 111_320, (lonA - lonB) * 111_320 * Math.cos((latA * Math.PI) / 180))
  }
  return total
}

describe('traceTaxiRoute', () => {
  it('traces the real VHHH clearance "holding point B10, runway 25C, via B8, B" to the B10 hold (real bug, 2026-09-30)', () => {
    const route = traceTaxiRoute({ segments: VHHH, taxiways: ['B8', 'B'], holdingPoint: 'B10', from: STAND_END_OF_B8 })

    expect(route).not.toBeNull()
    expect(route!.at(-1)).toEqual(B10_HOLD_SHORT)
    // Matches the offline spike against the full network (~872 m) — not the ~3.9 km of all
    // of B that the old whole-name highlight lit up.
    expect(lengthM(route!)).toBeGreaterThan(800)
    expect(lengthM(route!)).toBeLessThan(950)
  })

  it('leaves the stand straight along B8, not zigzagging through the gate lead-ins beside it (VHHH, flight 230, 2026-10-05)', () => {
    // Real: parked on B8 after pushback (22.31644, 113.92902), cleared "via B, B, V, H, J". B8
    // isn't in the clearance; costed at 5× it lost to the unnamed lead-ins either side.
    const route = traceTaxiRoute({ segments: VHHH, taxiways: ['B'], holdingPoint: null, from: { lat: 22.316438264, lon: 113.929019435 }, stand: null })!
    const edgeNames = route.slice(1).map(([bLon, bLat], i) => {
      const [aLon, aLat] = route[i]!
      const seg = VHHH.find(
        (s) =>
          (s.startLat === aLat && s.startLon === aLon && s.endLat === bLat && s.endLon === bLon) ||
          (s.startLat === bLat && s.startLon === bLon && s.endLat === aLat && s.endLon === aLon)
      )
      return seg?.name ?? '-'
    })
    expect(edgeNames).toEqual(['B8', 'B8', 'B8', 'B8', 'B8', 'B8', 'B8', 'B8', 'A11', 'B'])
  })

  it('bridges the scenery-only "B12" stretch between B and B10 that ATC never names', () => {
    const route = traceTaxiRoute({ segments: VHHH, taxiways: ['B8', 'B'], holdingPoint: 'B10', from: STAND_END_OF_B8 })!
    const onRoute = new Set(route.map(([lon, lat]) => `${lon},${lat}`))
    const b12Used = VHHH.filter((s) => s.name === 'B12').some(
      (s) => onRoute.has(`${s.startLon},${s.startLat}`) && onRoute.has(`${s.endLon},${s.endLat}`)
    )
    expect(b12Used).toBe(true)
  })

  it('accepts a clearance that already lists the holding point as its last taxiway', () => {
    const route = traceTaxiRoute({ segments: VHHH, taxiways: ['B8', 'B', 'B10'], holdingPoint: 'B10', from: STAND_END_OF_B8 })
    expect(route!.at(-1)).toEqual(B10_HOLD_SHORT)
  })

  it('returns null (caller falls back to whole-name highlight) when the holding point is not a taxiway in the data', () => {
    expect(traceTaxiRoute({ segments: VHHH, taxiways: ['B8', 'B'], holdingPoint: 'Z9', from: STAND_END_OF_B8 })).toBeNull()
  })

  it("without any hold-short flags, runs to the holding-point taxiway's far end", () => {
    const noHoldFlags = VHHH.map((s) => ({ ...s, startHoldShort: false, endHoldShort: false }))
    const route = traceTaxiRoute({ segments: noHoldFlags, taxiways: ['B8', 'B'], holdingPoint: 'B10', from: STAND_END_OF_B8 })
    expect(namesDriven(noHoldFlags, route!).at(-1)).toBe('B10')
  })

  it('traces the real YBBN clearance "holding point A9, runway 01R, via C9, B9" to where the aircraft stopped (2026-10-02)', () => {
    // A9's only hold-short flag is at its B9 end, where the aircraft enters it — this used to
    // fail every YBBN trace and fall back to whole taxiways (the "star at every junction").
    const atTaxiStart = { lat: -27.40268, lon: 153.11282 } // the real track, start of taxi
    const stoppedAtA9 = { lat: -27.40262, lon: 153.11832 } // the real track, holding at A9
    const route = traceTaxiRoute({ segments: YBBN, taxiways: ['C9', 'B9'], holdingPoint: 'A9', from: atTaxiStart })

    expect(route).not.toBeNull()
    expect(namesDriven(YBBN, route!)).toEqual(['C9', 'B9', 'A9'])
    const [endLon, endLat] = route!.at(-1)!
    expect(distanceM({ lat: endLat, lon: endLon }, stoppedAtA9)).toBeLessThan(25)
  })

  it('traces the real ZJSY clearance "holding point A, runway 08, via D, B7, A" to the runway 08 hold (2026-10-02)', () => {
    // Real bug: the line ended just past B7, one unnamed fillet off A, instead of following A
    // west to its hold short by the runway 08 threshold, where Callum actually held.
    const onD = { lat: 18.3074072, lon: 109.4093493 }
    const runway08Hold = { lat: 18.30168, lon: 109.39634 } // A's only hold-short point
    const route = traceTaxiRoute({ segments: ZJSY, taxiways: ['D', 'B7', 'A'], holdingPoint: 'A', from: onD })

    expect(route).not.toBeNull()
    expect(namesDriven(ZJSY, route!)).toEqual(['D', 'B7', 'A'])
    const [endLon, endLat] = route!.at(-1)!
    expect(distanceM({ lat: endLat, lon: endLon }, runway08Hold)).toBeLessThan(5)
  })

  it('traces the real VHHH "taxi via C7, Y, F, hold short of runway 07C" to the hold short on F (2026-10-02)', () => {
    // After landing 07L, the first half of a split clearance. F's only hold-short point is
    // between 07L and 07C, ~195 m north of 07C's centreline. Traced the same way as a holding
    // point, with the last taxiway (F) as the one to hold on.
    const offC7 = { lat: 22.3267351, lon: 113.9016593 } // the top of C7, just off 07L
    const holdShort07C = { lat: 22.32092, lon: 113.92363 }
    const route = traceTaxiRoute({ segments: VHHH_HOLD_07C, taxiways: ['C7', 'Y', 'F'], holdingPoint: 'F', from: offC7 })

    expect(route).not.toBeNull()
    // Y reaches F through a short stretch the scenery calls D, which ATC doesn't name.
    expect(namesDriven(VHHH_HOLD_07C, route!)).toEqual(['C7', 'Y', 'D', 'F'])
    const [endLon, endLat] = route!.at(-1)!
    expect(distanceM({ lat: endLat, lon: endLon }, holdShort07C)).toBeLessThan(5)
  })

  it('traces the real VHHH stand clearance "taxi to Stand N32 via J, H6, H, V, B" as far as joining B (2026-10-02)', () => {
    // The facility data has no stands — so the certain part of the route, not every segment
    // of J, H6, H, V and B across the airport (the "very wrong route" report).
    const vacatedOntoJ = { lat: 22.30184, lon: 113.91052 } // the real track, slowed after vacating
    const route = traceTaxiRoute({ segments: VHHH_ARRIVAL, taxiways: ['J', 'H6', 'H', 'V', 'B'], holdingPoint: null, from: vacatedOntoJ })

    expect(route).not.toBeNull()
    // Starts on J5 — the high-speed exit the aircraft was still on.
    expect(namesDriven(VHHH_ARRIVAL, route!)).toEqual(['J5', 'J', 'H6', 'H', 'V', 'B'])
    expect(lengthM(route!)).toBeLessThan(3_000)
  })

  it('traces the same VHHH clearance all the way to stand N32 once its position is known (stand-positions.md)', () => {
    const vacatedOntoJ = { lat: 22.30184, lon: 113.91052 }
    // N32 from the sim's own stand data, and where the real flight stopped.
    const n32 = { lat: 22.31414534384843, lon: 113.92862486374908 }
    const stoppedAtN32 = { lat: 22.31404, lon: 113.92867 }
    const route = traceTaxiRoute({ segments: VHHH_ARRIVAL, taxiways: ['J', 'H6', 'H', 'V', 'B'], holdingPoint: null, from: vacatedOntoJ, stand: n32 })!

    expect(namesDriven(VHHH_ARRIVAL, route).slice(0, 6)).toEqual(['J5', 'J', 'H6', 'H', 'V', 'B'])
    expect(route.at(-1)).toEqual([n32.lon, n32.lat])
    const [endLon, endLat] = route.at(-1)!
    expect(distanceM({ lat: endLat, lon: endLon }, stoppedAtN32)).toBeLessThan(20)
    expect(lengthM(route)).toBeLessThan(5_000)
  })

  it("falls back to joining the last taxiway when the stand can't be reached through the network", () => {
    const vacatedOntoJ = { lat: 22.30184, lon: 113.91052 }
    const nowhere = { lat: 22.35, lon: 113.99 }
    const route = traceTaxiRoute({ segments: VHHH_ARRIVAL, taxiways: ['J', 'H6', 'H', 'V', 'B'], holdingPoint: null, from: vacatedOntoJ, stand: nowhere })!
    expect(namesDriven(VHHH_ARRIVAL, route).at(-1)).toBe('B')
    expect(route.at(-1)).not.toEqual([nowhere.lon, nowhere.lat])
  })

  it('returns null when the aircraft is nowhere near the taxi network', () => {
    expect(traceTaxiRoute({ segments: VHHH, taxiways: ['B8', 'B'], holdingPoint: 'B10', from: { lat: 22.4, lon: 114.1 } })).toBeNull()
  })
})

describe('traceTaxiRoute on a hand-built junction', () => {
  const seg = (a: [number, number], b: [number, number], name: string | null, endHoldShort = false): NavdataTaxiSegment => ({
    startLat: a[0],
    startLon: a[1],
    endLat: b[0],
    endLon: b[1],
    name,
    startHoldShort: false,
    endHoldShort
  })

  it('never drives out along a taxiway and straight back just to "use" it', () => {
    // The hold on A1 leaves right at the D/B junction; B only runs away from it.
    const route = traceTaxiRoute({
      segments: [
        seg([51.33, 0.03], [51.331, 0.031], 'D'),
        seg([51.331, 0.031], [51.34, 0.05], 'B'),
        seg([51.331, 0.031], [51.3315, 0.0315], 'A1', true)
      ],
      taxiways: ['D', 'B'],
      holdingPoint: 'A1',
      from: { lat: 51.33, lon: 0.03 }
    })
    expect(route?.some(([lon]) => lon === 0.05) ?? false).toBe(false)
  })
})

describe('remainingRoute', () => {
  // An out-and-back dogleg: east along 51.33N, then north, then back west close to the start.
  const ROUTE: [number, number][] = [
    [0.03, 51.33],
    [0.032, 51.33],
    [0.032, 51.3305],
    [0.0301, 51.3305]
  ]

  it('starts at the aircraft, joins the line where it is, and drops what is behind', () => {
    const { line, segment } = remainingRoute(ROUTE, { lat: 51.3301, lon: 0.031 })
    expect(segment).toBe(0)
    expect(line[0]).toEqual([0.031, 51.3301])
    expect(line[1]![0]).toBeCloseTo(0.031, 6)
    expect(line[1]![1]).toBeCloseTo(51.33, 6)
    expect(line.slice(2)).toEqual(ROUTE.slice(1))
  })

  it("never jumps back to an earlier part of the line that happens to pass close by", () => {
    // Near the start point, but already on the last leg (segment 2), which passes 55 m north of it.
    const { segment } = remainingRoute(ROUTE, { lat: 51.3304, lon: 0.0302 }, 2)
    expect(segment).toBe(2)
  })

  it('leaves the line alone when the aircraft is nowhere near it', () => {
    expect(remainingRoute(ROUTE, { lat: 51.34, lon: 0.03 }).line).toEqual(ROUTE)
  })
})
