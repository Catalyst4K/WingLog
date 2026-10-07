import { describe, expect, it } from 'vitest'
import type { NavdataTaxiSegment } from '@shared/ipc'
import { angleBetweenDeg, rejoinTaxiRoute, remainingRoute, traceTaxiRoute } from './taxi-route-trace'
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
    // doesn't name, not in and out of every gate lead-in to avoid it (simulated, 2026-10-06).
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
      // On D facing away from B7, forwards is a loop. Before 2026-10-06 (a ×10 factor on the
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
