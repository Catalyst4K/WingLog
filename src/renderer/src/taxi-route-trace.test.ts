import { describe, expect, it } from 'vitest'
import type { NavdataTaxiSegment } from '@shared/ipc'
import { rejoinTaxiRoute, remainingRoute } from './taxi-route-rejoin'
import { angleBetweenDeg, traceTaxiRoute } from './taxi-route-trace'
import VHHH_RAW from './__fixtures__/vhhh-taxi-b8-b10.json'
import VHHH_ARRIVAL_RAW from './__fixtures__/vhhh-taxi-arrival-j-h6-h-v-b.json'
import YBBN_RAW from './__fixtures__/ybbn-taxi-c9-b9-a9.json'
import ZJSY_RAW from './__fixtures__/zjsy-taxi-d-b7-a.json'
import VHHH_HOLD_07C_RAW from './__fixtures__/vhhh-taxi-c7-y-f-hold-07c.json'
import EGCC_RAW from './__fixtures__/egcc-taxi-e-d-b-a-hold-05l.json'
import EGLL_RAW from './__fixtures__/egll-taxi-s3-a1-hold-27r.json'

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
// VHHH, fetched live: ~1.2 km around the east end of runway 25C.
const VHHH = toSegments(VHHH_RAW)
// YBBN and VHHH from the real YBBN-VHHH flight, around the departure and arrival taxi routes.
const YBBN = toSegments(YBBN_RAW)
const VHHH_ARRIVAL = toSegments(VHHH_ARRIVAL_RAW)
// The whole airport, so A's far ends are real ends rather than the edge of a trimmed box.
const ZJSY = toSegments(ZJSY_RAW)
const VHHH_HOLD_07C = toSegments(VHHH_HOLD_07C_RAW)
// EGCC, fetched live 2026-10-17: the parallel taxiway A beside runway 05L/23R, from the north apron.
const EGCC = toSegments(EGCC_RAW)
// EGLL, fetched live: flight 239's departure, S3 to A1 for runway 27R.
const EGLL = toSegments(EGLL_RAW)

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

/** How many times a route leaves a named taxiway through unnamed segments (gate lead-ins,
 *  fillets) and comes straight back to the same one: the zigzag through gate lead-ins. */
function detours(segments: NavdataTaxiSegment[], route: [number, number][]): number {
  const names: (string | null | undefined)[] = []
  for (let i = 1; i < route.length; i++) {
    const [aLon, aLat] = route[i - 1]!
    const [bLon, bLat] = route[i]!
    const seg = segments.find(
      (s) =>
        (s.startLat === aLat && s.startLon === aLon && s.endLat === bLat && s.endLon === bLon) ||
        (s.startLat === bLat && s.startLon === bLon && s.endLat === aLat && s.endLon === aLon)
    )
    names.push(seg ? seg.name : undefined)
  }
  let count = 0
  for (let i = 1; i < names.length; i++) {
    if (names[i] !== null || !names[i - 1]) continue
    let j = i
    while (j < names.length && names[j] === null) j++
    if (j < names.length && names[j] === names[i - 1]) count++
    i = j
  }
  return count
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
    const route = traceTaxiRoute({
      segments: VHHH,
      taxiways: ['B8', 'B'],
      holdingPoint: 'B10',
      from: STAND_END_OF_B8
    })

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
    const route = traceTaxiRoute({
      segments: VHHH,
      taxiways: ['B'],
      holdingPoint: null,
      from: { lat: 22.316438264, lon: 113.929019435 },
      stand: null
    })!
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
    const route = traceTaxiRoute({
      segments: VHHH,
      taxiways: ['B8', 'B'],
      holdingPoint: 'B10',
      from: STAND_END_OF_B8
    })!
    const onRoute = new Set(route.map(([lon, lat]) => `${lon},${lat}`))
    const b12Used = VHHH.filter((s) => s.name === 'B12').some(
      (s) => onRoute.has(`${s.startLon},${s.startLat}`) && onRoute.has(`${s.endLon},${s.endLat}`)
    )
    expect(b12Used).toBe(true)
  })

  it('accepts a clearance that already lists the holding point as its last taxiway', () => {
    const route = traceTaxiRoute({
      segments: VHHH,
      taxiways: ['B8', 'B', 'B10'],
      holdingPoint: 'B10',
      from: STAND_END_OF_B8
    })
    expect(route!.at(-1)).toEqual(B10_HOLD_SHORT)
  })

  it('returns null (caller falls back to whole-name highlight) when the holding point is not a taxiway in the data', () => {
    expect(
      traceTaxiRoute({ segments: VHHH, taxiways: ['B8', 'B'], holdingPoint: 'Z9', from: STAND_END_OF_B8 })
    ).toBeNull()
  })

  it("without any hold-short flags, runs to the holding-point taxiway's far end", () => {
    const noHoldFlags = VHHH.map((s) => ({ ...s, startHoldShort: false, endHoldShort: false }))
    const route = traceTaxiRoute({
      segments: noHoldFlags,
      taxiways: ['B8', 'B'],
      holdingPoint: 'B10',
      from: STAND_END_OF_B8
    })
    expect(namesDriven(noHoldFlags, route!).at(-1)).toBe('B10')
  })

  it('traces the real YBBN clearance "holding point A9, runway 01R, via C9, B9" to where the aircraft stopped (2026-10-02)', () => {
    // A9's only hold-short flag is at its B9 end, where the aircraft enters it — this used to
    // fail every YBBN trace and fall back to whole taxiways (the "star at every junction").
    const atTaxiStart = { lat: -27.40268, lon: 153.11282 } // the real track, start of taxi
    const stoppedAtA9 = { lat: -27.40262, lon: 153.11832 } // the real track, holding at A9
    const route = traceTaxiRoute({
      segments: YBBN,
      taxiways: ['C9', 'B9'],
      holdingPoint: 'A9',
      from: atTaxiStart
    })

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
    const route = traceTaxiRoute({
      segments: VHHH_HOLD_07C,
      taxiways: ['C7', 'Y', 'F'],
      holdingPoint: 'F',
      from: offC7
    })

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
    const route = traceTaxiRoute({
      segments: VHHH_ARRIVAL,
      taxiways: ['J', 'H6', 'H', 'V', 'B'],
      holdingPoint: null,
      from: vacatedOntoJ
    })

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
    const route = traceTaxiRoute({
      segments: VHHH_ARRIVAL,
      taxiways: ['J', 'H6', 'H', 'V', 'B'],
      holdingPoint: null,
      from: vacatedOntoJ,
      stand: n32
    })!

    expect(namesDriven(VHHH_ARRIVAL, route).slice(0, 6)).toEqual(['J5', 'J', 'H6', 'H', 'V', 'B'])
    expect(route.at(-1)).toEqual([n32.lon, n32.lat])
    // From B to the stand is the pilot's choice: straight along the gate taxilane B7, which ATC
    // doesn't name, not in and out of every gate lead-in to avoid it (simulated).
    expect(namesDriven(VHHH_ARRIVAL, route).at(-1)).toBe('B7')
    expect(detours(VHHH_ARRIVAL, route)).toBe(0)
    const [endLon, endLat] = route.at(-1)!
    expect(distanceM({ lat: endLat, lon: endLon }, stoppedAtN32)).toBeLessThan(20)
    expect(lengthM(route)).toBeLessThan(5_000)
  })

  it("falls back to joining the last taxiway when the stand can't be reached through the network", () => {
    const vacatedOntoJ = { lat: 22.30184, lon: 113.91052 }
    const nowhere = { lat: 22.35, lon: 113.99 }
    const route = traceTaxiRoute({
      segments: VHHH_ARRIVAL,
      taxiways: ['J', 'H6', 'H', 'V', 'B'],
      holdingPoint: null,
      from: vacatedOntoJ,
      stand: nowhere
    })!
    expect(namesDriven(VHHH_ARRIVAL, route).at(-1)).toBe('B')
    expect(route.at(-1)).not.toEqual([nowhere.lon, nowhere.lat])
  })

  it('returns null when the aircraft is nowhere near the taxi network', () => {
    expect(
      traceTaxiRoute({
        segments: VHHH,
        taxiways: ['B8', 'B'],
        holdingPoint: 'B10',
        from: { lat: 22.4, lon: 114.1 }
      })
    ).toBeNull()
  })
})

describe('traceTaxiRoute on a hand-built junction', () => {
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

describe('traceTaxiRoute where the cheapest way to a point is from the point the route must leave towards', () => {
  const seg = (
    a: [number, number],
    b: [number, number],
    name: string,
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

  it('still finds "A, B, A" when A also runs straight to the far junction (airport-rules found this at YBBN, ZSPD, RKSI)', () => {
    // A runs straight from the start to P, and round via Q. B joins Q to X to P. Clearance A, B, A to the hold beyond P: the
    // route must go A to Q, B to X and on to P, then A to the hold. Reaching X from P (straight A, then B) is cheaper, but
    // that arrival can't carry on to P without a U-turn.
    const start: [number, number] = [51.0, 0.0]
    const p: [number, number] = [51.002, 0.0]
    const q: [number, number] = [51.0, 0.0015]
    const x: [number, number] = [51.002, 0.0008]
    const hold: [number, number] = [51.004, 0.0]
    const route = traceTaxiRoute({
      segments: [
        seg(start, p, 'A'),
        seg(start, q, 'A'),
        seg(q, x, 'B'),
        seg(x, p, 'B'),
        seg(p, hold, 'A', true)
      ],
      taxiways: ['A', 'B', 'A'],
      holdingPoint: null,
      from: { lat: start[0], lon: start[1] }
    })
    expect(route).toEqual([
      [0.0, 51.0],
      [0.0015, 51.0],
      [0.0008, 51.002],
      [0.0, 51.002],
      [0.0, 51.004]
    ])
  })
})

describe('re-routing (taxi-reroute.md)', () => {
  const onD = { lat: 18.3074072, lon: 109.4093493 }
  const runway08Hold = { lat: 18.30168, lon: 109.39634 }
  const ZJSY_REQUEST = { segments: ZJSY, taxiways: ['D', 'B7', 'A'], holdingPoint: 'A' }
  // Flight 227's stand, and a point 18 s into its wrong-way taxi, heading west.
  const STAND_227 = { lat: 18.3075447, lon: 109.4041842 }
  const TAXIING_WEST_227 = { lat: 18.3067402, lon: 109.4036881 }
  const bearing = ([aLon, aLat]: [number, number], [bLon, bLat]: [number, number]): number =>
    ((Math.atan2((bLon - aLon) * Math.cos((aLat * Math.PI) / 180), bLat - aLat) * 180) / Math.PI + 360) % 360
  /** The direction of the first edge that actually moves. */
  const firstBearing = (route: [number, number][]): number => {
    const i = route.findIndex((p, k) => k > 0 && (p[0] !== route[0]![0] || p[1] !== route[0]![1]))
    return bearing(route[0]!, route[i]!)
  }

  describe('traceTaxiRoute with a heading', () => {
    it("starts forwards, not with a U-turn against the aircraft's heading, when a forward way exists (ZJSY flight 227)", () => {
      // Real: three seconds into taxiing after the wrong-way pushback, heading 262. Without the
      // heading the line starts back east, behind the aircraft, towards D.
      const taxiing = { lat: 18.3067963, lon: 109.4041206 }
      const plain = traceTaxiRoute({ ...ZJSY_REQUEST, from: taxiing })!
      const route = traceTaxiRoute({ ...ZJSY_REQUEST, from: taxiing, headingDeg: 262 })!

      expect(angleBetweenDeg(firstBearing(plain), 262)).toBeGreaterThan(120)
      expect(angleBetweenDeg(firstBearing(route), 262)).toBeLessThanOrEqual(120)
      const [endLon, endLat] = route.at(-1)!
      expect(distanceM({ lat: endLat, lon: endLon }, runway08Hold)).toBeLessThan(5)
    })

    it("goes forwards even the long way round: an airliner can't turn round mid-taxiway", () => {
      // On D facing away from B7, forwards is a loop. Before (a ×10 factor on the
      // first edge) the U-turn won; YBBN's simulated re-routes then pointed back behind the
      // aircraft twice before following it.
      const plain = traceTaxiRoute({ ...ZJSY_REQUEST, from: onD })!
      const facingAway = (firstBearing(plain) + 180) % 360
      const route = traceTaxiRoute({ ...ZJSY_REQUEST, from: onD, headingDeg: facingAway })!
      expect(angleBetweenDeg(firstBearing(route), facingAway)).toBeLessThanOrEqual(120)
      const [endLon, endLat] = route.at(-1)!
      expect(distanceM({ lat: endLat, lon: endLon }, runway08Hold)).toBeLessThan(5)
    })

    it('still turns round at a dead end, where there is no way forwards', () => {
      // A stand lead-in's dead end, nose in: the only way out is back the way it came.
      const ends = ZJSY.flatMap((s) => [
        { lat: s.startLat, lon: s.startLon, toward: [s.endLon, s.endLat] as [number, number] },
        { lat: s.endLat, lon: s.endLon, toward: [s.startLon, s.startLat] as [number, number] }
      ])
      const degree = new Map<string, number>()
      for (const e of ends) degree.set(`${e.lat},${e.lon}`, (degree.get(`${e.lat},${e.lon}`) ?? 0) + 1)
      const deadEnd = ends
        .filter((e) => degree.get(`${e.lat},${e.lon}`) === 1)
        .sort((x, y) => distanceM(x, STAND_227) - distanceM(y, STAND_227))[0]!
      // Facing into the dead end: directly away from its only edge.
      const nose = (bearing([deadEnd.lon, deadEnd.lat], deadEnd.toward) + 180) % 360
      const route = traceTaxiRoute({ ...ZJSY_REQUEST, from: deadEnd, headingDeg: nose })
      expect(route).not.toBeNull()
      expect(route).toEqual(traceTaxiRoute({ ...ZJSY_REQUEST, from: deadEnd }))
    })
  })

  describe('rejoinTaxiRoute', () => {
    const CLEARED = traceTaxiRoute({ ...ZJSY_REQUEST, from: STAND_227 })!
    /** Where `route` joins CLEARED: the first index from which its tail is CLEARED's tail. */
    const joinIndexOf = (route: [number, number][]): number =>
      CLEARED.findIndex((_, k) => {
        const tail = CLEARED.slice(k)
        return (
          route.length >= tail.length && JSON.stringify(route.slice(-tail.length)) === JSON.stringify(tail)
        )
      })

    it("joins flight 227's cleared route on A near the hold, the way the aircraft is going", () => {
      const route = rejoinTaxiRoute({
        segments: ZJSY,
        route: CLEARED,
        fromSegment: 0,
        from: TAXIING_WEST_227,
        headingDeg: 262
      })!

      expect(route.at(-1)).toEqual(CLEARED.at(-1))
      // Joins on the last stretch: under a third of the cleared route is left from there.
      expect(lengthM(CLEARED.slice(joinIndexOf(route)))).toBeLessThan(lengthM(CLEARED) / 3)
      expect(namesDriven(ZJSY, route).at(-1)).toBe('A')
      expect(angleBetweenDeg(firstBearing(route), 262)).toBeLessThanOrEqual(120)
      // Much shorter than turning round and driving the cleared route.
      const back = traceTaxiRoute({ ...ZJSY_REQUEST, from: TAXIING_WEST_227 })!
      expect(lengthM(route)).toBeLessThan(lengthM(back) * 0.8)
    })

    it('keeps the rest of the cleared route when the aircraft is already on it, heading along it', () => {
      const k = CLEARED.length - 6
      const [lon, lat] = CLEARED[k]!
      const route = rejoinTaxiRoute({
        segments: ZJSY,
        route: CLEARED,
        fromSegment: k,
        from: { lat, lon },
        headingDeg: bearing(CLEARED[k]!, CLEARED[k + 1]!)
      })!
      expect(route).toEqual(CLEARED.slice(k))
    })

    it('with only the end left to join (everything else driven), takes the shortest way to it', () => {
      const all = rejoinTaxiRoute({
        segments: ZJSY,
        route: CLEARED,
        fromSegment: 0,
        from: TAXIING_WEST_227,
        headingDeg: 262
      })!
      const endOnly = rejoinTaxiRoute({
        segments: ZJSY,
        route: CLEARED,
        fromSegment: CLEARED.length - 1,
        from: TAXIING_WEST_227,
        headingDeg: 262
      })!
      expect(endOnly.at(-1)).toEqual(CLEARED.at(-1))
      expect(lengthM(endOnly)).toBeCloseTo(lengthM(all), 0)
    })

    it('gives up off the network, so the caller keeps the line it has', () => {
      expect(
        rejoinTaxiRoute({ segments: ZJSY, route: CLEARED, fromSegment: 0, from: { lat: 18.4, lon: 109.5 } })
      ).toBeNull()
      expect(rejoinTaxiRoute({ segments: ZJSY, route: [], fromSegment: 0, from: STAND_227 })).toBeNull()
    })

    it("keeps a stand clearance's own stand point (not on the network) at the end", () => {
      const [endLon, endLat] = CLEARED.at(-1)!
      const standPoint: [number, number] = [endLon + 0.0002, endLat] // ~20 m on
      const route = rejoinTaxiRoute({
        segments: ZJSY,
        route: [...CLEARED, standPoint],
        fromSegment: 0,
        from: TAXIING_WEST_227,
        headingDeg: 262
      })!
      expect(route.at(-1)).toEqual(standPoint)
      expect(route.at(-2)).toEqual(CLEARED.at(-1))
    })
  })
})

describe('angleBetweenDeg', () => {
  it('is the smaller angle either way round, across north', () => {
    expect(angleBetweenDeg(350, 10)).toBe(20)
    expect(angleBetweenDeg(10, 350)).toBe(20)
    expect(angleBetweenDeg(82, 262)).toBe(180)
    expect(angleBetweenDeg(-90, 270)).toBe(0)
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

  it('never jumps back to an earlier part of the line that happens to pass close by', () => {
    // Near the start point, but already on the last leg (segment 2), which passes 55 m north of it.
    const { segment } = remainingRoute(ROUTE, { lat: 51.3304, lon: 0.0302 }, 2)
    expect(segment).toBe(2)
  })

  it('leaves the line alone when the aircraft is nowhere near it', () => {
    expect(remainingRoute(ROUTE, { lat: 51.34, lon: 0.03 }).line).toEqual(ROUTE)
  })

  it("reports the aircraft's distance from the line and the line's direction there", () => {
    const near = remainingRoute(ROUTE, { lat: 51.3301, lon: 0.031 })
    expect(near.distanceM).toBeCloseTo(11.1, 0)
    expect(near.bearingDeg).toBeCloseTo(90, 0) // the first leg runs east
    // Still reported when too far to follow, so a re-route can tell how far off it is.
    const far = remainingRoute(ROUTE, { lat: 51.34, lon: 0.03 })
    expect(far.distanceM).toBeGreaterThan(1000)
  })

  it('has no direction for a one-point route', () => {
    expect(remainingRoute([[0.03, 51.33]], { lat: 51.33, lon: 0.03 }).bearingDeg).toBeNull()
  })
})

describe('traceTaxiRoute: the hold short beside the cleared runway (EGCC, 2026-10-17)', () => {
  // BeyondATC: "taxi to holding point A, runway 05L, via E, D, B, A", and its own map ends the line at A's hold short by the 05L
  // numbers. A has a hold short at each end of the runway; the route comes in from the north, so the far (23R) one was reached first.
  const FROM = { lat: 53.36099230499224, lon: -2.2790271040177106 }
  const THRESHOLD_05L = { lat: 53.345140869529, lon: -2.2927934260192853 }
  const request = { segments: EGCC, taxiways: ['E', 'D', 'B', 'A'], holdingPoint: 'A', from: FROM }
  const endOf = (route: ReturnType<typeof traceTaxiRoute>): [number, number] | undefined => route?.at(-1)

  it('ends at the hold short nearest the cleared runway threshold', () => {
    const end = endOf(traceTaxiRoute({ ...request, runwayThreshold: THRESHOLD_05L }))
    expect(end).toBeDefined()
    expect(distanceM({ lat: end![1], lon: end![0] }, { lat: 53.3466, lon: -2.29343 })).toBeLessThan(15)
  })

  it('keeps the first hold short reached when no runway is known, as before', () => {
    const end = endOf(traceTaxiRoute(request))
    expect(distanceM({ lat: end![1], lon: end![0] }, { lat: 53.35576, lon: -2.28002 })).toBeLessThan(15)
  })

  it('ignores a runway whose threshold is nowhere near the holding point', () => {
    const farAway = { lat: 53.4, lon: -2.2 }
    expect(endOf(traceTaxiRoute({ ...request, runwayThreshold: farAway }))).toEqual(
      endOf(traceTaxiRoute(request))
    )
  })
})

describe('traceTaxiRoute: a first hold short that is already beside the cleared runway stays (EGLL, flight 239, 2026-10-15)', () => {
  // "Taxi to runway 27R ... hold position A1": the aircraft went to the first A1 hold short the search reaches, 150 m from the 27R
  // threshold. A1's other hold short is about as near (149 m), so the runway must not swap one for the other.
  const request = {
    segments: EGLL,
    taxiways: ['S3', 'NB3', 'N3', 'L', 'B', 'LINK 25', 'A', 'LINK 23'],
    holdingPoint: 'A1',
    from: { lat: 51.463254679102654, lon: -0.44070621067071797 }
  }
  const THRESHOLD_27R = { lat: 51.477688154927705, lon: -0.4332168419824973 }

  it('ends where it did without the runway', () => {
    const plain = traceTaxiRoute(request)
    const withRunway = traceTaxiRoute({ ...request, runwayThreshold: THRESHOLD_27R })
    expect(plain).not.toBeNull()
    expect(withRunway?.at(-1)).toEqual(plain?.at(-1))
    expect(
      distanceM({ lat: plain!.at(-1)![1], lon: plain!.at(-1)![0] }, { lat: 51.47768, lon: -0.43539 })
    ).toBeLessThan(15)
  })
})

describe('traceTaxiRoute with the aircraft already past the start (EGCC 2026-10-18: Track opened mid-taxi)', () => {
  const seg = (a: [number, number], b: [number, number], name: string): NavdataTaxiSegment => ({
    startLat: a[0],
    startLon: a[1],
    endLat: b[0],
    endLon: b[1],
    name,
    startHoldShort: false,
    endHoldShort: false
  })
  // VC meets V only at its north end; the aircraft is on A, beyond the end of the cleared route's first half.
  const segments = [
    seg([53.344, -2.284], [53.3465, -2.282], 'VC'),
    seg([53.3465, -2.282], [53.349, -2.28], 'VC'),
    seg([53.349, -2.28], [53.35, -2.279], 'V'),
    seg([53.35, -2.279], [53.353, -2.2815], 'A')
  ]
  const request = {
    segments,
    taxiways: ['VC', 'V', 'A'],
    holdingPoint: null,
    from: { lat: 53.353, lon: -2.2815 }
  }

  it('traces from the aircraft by joining the clearance at A, where it already is, rather than going back for VC and V', () => {
    const route = traceTaxiRoute({
      ...request,
      taxiways: ['VC', 'V', 'A', 'D'],
      segments: [...segments, seg([53.353, -2.2815], [53.355, -2.284], 'D')]
    })
    expect(route).toEqual([
      [-2.2815, 53.353],
      [-2.284, 53.355]
    ])
  })
})

describe('rejoinTaxiRoute follows the cleared route once the way back meets it (EGLL flight 239, 2026-10-15)', () => {
  const seg = (a: [number, number], b: [number, number], name: string): NavdataTaxiSegment => ({
    startLat: a[0],
    startLon: a[1],
    endLat: b[0],
    endLon: b[1],
    name,
    startHoldShort: false,
    endHoldShort: false
  })
  const R = [
    [51.0, 0],
    [51.001, 0],
    [51.002, 0],
    [51.003, 0.002],
    [51.004, 0]
  ] as [number, number][]
  const P: [number, number] = [51.001, -0.0004]
  // The cleared X runs round R3; Z cuts straight from R2 to R4, the shorter way to the end.
  const segments = [
    seg(R[0]!, R[1]!, 'X'),
    seg(R[1]!, R[2]!, 'X'),
    seg(R[2]!, R[3]!, 'X'),
    seg(R[3]!, R[4]!, 'X'),
    seg(R[2]!, R[4]!, 'Z'),
    seg(P, R[1]!, 'Y')
  ]
  const route = R.map(([lat, lon]): [number, number] => [lon, lat])

  it('keeps the cleared stretch after the join instead of cutting to a later join over the shortcut', () => {
    const rejoined = rejoinTaxiRoute({ segments, route, fromSegment: 0, from: { lat: P[0], lon: P[1] } })
    expect(rejoined?.[0]).toEqual([P[1], P[0]])
    expect(rejoined?.slice(1)).toEqual(route.slice(1))
  })
})

describe('traceTaxiRoute ends at a hold short reached by an unnamed fillet (RKSI flight 239, 2026-10-16)', () => {
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
  const A: [number, number] = [51.0, 0]
  const J: [number, number] = [51.001, 0]
  const K: [number, number] = [51.002, 0]
  const H: [number, number] = [51.0025, 0.0005]
  const M: [number, number] = [51.003, 0.001]

  it('stops at the hold short instead of going on to the far end of the taxiway', () => {
    const route = traceTaxiRoute({
      segments: [seg(A, J, 'P'), seg(J, K, 'P'), seg(K, H, null, true), seg(H, M, 'P')],
      taxiways: ['P'],
      holdingPoint: 'P',
      from: { lat: A[0], lon: A[1] }
    })
    expect(route?.at(-1)).toEqual([H[1], H[0]])
  })
})

describe('traceTaxiRoute with a hold short of a runway (RKSI flight 239, 2026-10-16)', () => {
  const seg = (
    a: [number, number],
    b: [number, number],
    name: string,
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
  // A runway running north from its threshold, 60 m wide. P runs alongside it; P9 turns off P across to it, with a hold short
  // 100 m from its edge. P's own hold short is at its far end, 1.5 km on.
  const runway = { thresholdLat: 51.0, thresholdLon: 0, headingTrueDeg: 0, lengthM: 4000, widthM: 60 }
  const metres = (m: number): number => m / 111_320
  const P0: [number, number] = [51 + metres(500), -metres(300)]
  const P1: [number, number] = [51 + metres(700), -metres(300)]
  const P2: [number, number] = [51 + metres(2200), -metres(300)]
  const P9HOLD: [number, number] = [51 + metres(700), -metres(130)]
  const request = {
    segments: [seg(P0, P1, 'P'), seg(P1, P2, 'P', true), seg(P1, P9HOLD, 'P9', true)],
    taxiways: ['P'],
    holdingPoint: 'P',
    from: { lat: P0[0], lon: P0[1] }
  }

  it('ends at the first hold short beside the runway, which can be on another taxiway', () => {
    const route = traceTaxiRoute({ ...request, holdShortRunway: runway })
    expect(route?.at(-1)).toEqual([P9HOLD[1], P9HOLD[0]])
  })

  it("without the runway, goes on to the taxiway's own hold short", () => {
    expect(traceTaxiRoute(request)?.at(-1)).toEqual([P2[1], P2[0]])
  })
})

describe('traceTaxiRoute to a runway threshold with no hold short on the holding-point taxiway (WSSS 2026-10-19)', () => {
  const seg = (
    a: [number, number],
    b: [number, number],
    name: string,
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
  const metres = (m: number): number => m / 111_320
  const A: [number, number] = [51.0, 0]
  const J: [number, number] = [51 + metres(500), 0]
  const K: [number, number] = [51 + metres(3500), 0]
  const H: [number, number] = [51 + metres(3550), metres(60)]
  const request = {
    segments: [seg(A, J, 'P'), seg(J, K, 'T'), seg(K, H, 'T12', true)],
    taxiways: ['P', 'T'],
    holdingPoint: 'T',
    from: { lat: A[0], lon: A[1] }
  }

  it('without the runway, stops where the taxiway name stops', () => {
    expect(traceTaxiRoute(request)?.at(-1)).toEqual([K[1], K[0]])
  })

  it('with the runway threshold, goes on to the hold short beside it, on a branch of the taxiway', () => {
    const route = traceTaxiRoute({ ...request, runwayThreshold: { lat: 51 + metres(3600), lon: 0 } })
    expect(route?.at(-1)).toEqual([H[1], H[0]])
  })
})
