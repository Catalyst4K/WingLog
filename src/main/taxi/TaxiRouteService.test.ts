import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BeyondAtcInfoBox,
  FlightPhase,
  NavdataStand,
  NavdataTaxiSegment,
  SimTelemetry
} from '@shared/ipc'
import { EMPTY_BEYONDATC_STATE } from '@shared/beyondatc-state'
import type { TaxiRoute } from '@shared/live'
import { angleBetweenDeg } from '@shared/taxi/route-graph'
import { LiveHub } from '../live/LiveHub'
import type { ShownFlight } from '../navdata/flight-navdata-fetcher'
import { logger } from '../logging/logger'
import { TaxiRouteService } from './TaxiRouteService'
import REPLAY_225 from '@shared/taxi/__fixtures__/ybbn-225-taxi-out.json'
import YBBN_225_RAW from '@shared/taxi/__fixtures__/ybbn-225-taxi-network.json'
import REPLAY_227 from '@shared/taxi/__fixtures__/zjsy-227-taxi-out.json'
import REPLAY_253 from '@shared/taxi/__fixtures__/zjsy-253-taxi-out.json'
import VHHH_HOLD_RAW from '@shared/taxi/__fixtures__/vhhh-taxi-c7-y-f-hold-07c.json'
import ZJSY_RAW from '@shared/taxi/__fixtures__/zjsy-taxi-d-b7-a.json'

vi.mock('../logging/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }))

// Real taxi networks (MSFS facility data from WingLog's cache) and real taxis (flights 225, 227 and 253), as the taxi code's own tests use
// them. Rows: [startLat, startLon, endLat, endLon, name, startHoldShort, endHoldShort]; samples [seconds, lat, lon, heading, speed, phase].
type Row = [number, number, number, number, string | null, number, number]
const toSegments = (raw: unknown): NavdataTaxiSegment[] =>
  (raw as Row[]).map(([startLat, startLon, endLat, endLon, name, startHoldShort, endHoldShort]) => ({
    startLat,
    startLon,
    endLat,
    endLon,
    name,
    startHoldShort: startHoldShort === 1,
    endHoldShort: endHoldShort === 1
  }))
const ZJSY = toSegments(ZJSY_RAW)
const VHHH_HOLD = toSegments(VHHH_HOLD_RAW)
const YBBN = toSegments(YBBN_225_RAW)
type Sample = [number, number, number, number, number, string]

/** "Taxi to holding point A, runway 08, via D, B7, A". */
const D_B7_A: BeyondAtcInfoBox[] = [
  { title: 'Taxi to Runway', info: '08' },
  { title: 'Taxi Via 1', info: 'D' },
  { title: 'Taxi Via 2', info: 'B7' },
  { title: 'Taxi Via 3', info: 'A' },
  { title: 'Hold Position', info: 'A' }
]
const D_A3_A: BeyondAtcInfoBox[] = [
  { title: 'Taxi to Runway', info: '08' },
  { title: 'Taxi Via 1', info: 'D' },
  { title: 'Taxi Via 2', info: 'A3' },
  { title: 'Taxi Via 3', info: 'A' },
  { title: 'Hold Position', info: 'A' }
]
const C9_B9_A9: BeyondAtcInfoBox[] = [
  { title: 'Taxi Via 1', info: 'C9' },
  { title: 'Taxi Via 2', info: 'B9' },
  { title: 'Hold Position', info: 'A9' }
]
const RUNWAY_08_HOLD = { lat: 18.30168, lon: 109.39634 }

const distanceM = (a: { lat: number; lon: number }, b: { lat: number; lon: number }): number =>
  Math.hypot((a.lat - b.lat) * 111_320, (a.lon - b.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180))

interface World {
  hub: LiveHub
  published: (TaxiRoute | null)[]
  /** The latest non-null route published. */
  last: () => TaxiRoute | null
  telemetry: (sample: Sample) => void
  clearance: (boxes: BeyondAtcInfoBox[]) => void
  setNow: (ms: number) => void
  state: {
    flight: ShownFlight | undefined
    active: { flightId: number; phase: FlightPhase } | undefined
    networks: Record<string, NavdataTaxiSegment[]>
    stands: Record<string, NavdataStand[]>
  }
  refresh: (icao: string) => void
  stop: () => void
}

/** A service on a real hub, with a fake navdata cache and the flight, tracking and clock the test sets. */
function setup(over: Partial<World['state']> = {}): World {
  const hub = new LiveHub()
  const published: (TaxiRoute | null)[] = []
  hub.subscribe((topic, payload) => {
    if (topic === 'taxiRoute') published.push(payload as TaxiRoute | null)
  })
  const state: World['state'] = {
    flight: { flightId: 1, depIcao: 'ZJSY', arrIcao: 'VHHH', ofpJson: null },
    active: undefined,
    networks: { ZJSY },
    stands: {},
    ...over
  }
  let now = 0
  const listeners = new Set<(icao: string) => void>()
  const service = new TaxiRouteService({
    hub,
    navdata: {
      getTaxiNetwork: (icao) => state.networks[icao] ?? [],
      listRunways: () => [],
      getStands: (icao) => Promise.resolve(state.stands[icao] ?? []),
      onAirportRefreshed: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    },
    shownFlight: () => state.flight,
    active: () => state.active,
    now: () => now
  })
  const stop = service.start()
  return {
    hub,
    published,
    last: () => published.filter((p) => p !== null).at(-1) ?? null,
    telemetry: ([t, lat, lon, headingTrueDeg, groundSpeedMs, phase]) => {
      now = t * 1000
      if (state.active) state.active = { ...state.active, phase: phase as FlightPhase }
      hub.publish('simTelemetry', {
        latitude: lat,
        longitude: lon,
        headingTrueDeg,
        groundSpeedMs
      } as SimTelemetry)
    },
    clearance: (boxes) => hub.publish('beyondAtcState', { ...EMPTY_BEYONDATC_STATE, infoBoxes: boxes }),
    setNow: (ms) => {
      now = ms
    },
    state,
    refresh: (icao) => listeners.forEach((l) => l(icao)),
    stop
  }
}

beforeEach(() => {
  vi.mocked(logger.info).mockClear()
  vi.mocked(logger.warn).mockClear()
})

const ON_D: Sample = [0, 18.3074072, 109.4093493, 90, 5, 'taxi']

describe('TaxiRouteService: a clearance becomes a line', () => {
  it('traces a clearance from where the aircraft is and publishes it for the airport and flight', () => {
    const w = setup()
    w.telemetry(ON_D)
    expect(w.published).toEqual([])
    w.clearance(D_B7_A)
    const route = w.last()!
    expect(route).toMatchObject({
      flightId: 1,
      icao: 'ZJSY',
      kind: 'exact',
      clearance: { taxiways: ['D', 'B7', 'A'], holdingPoint: 'A', stand: null, holdShortRunway: null }
    })
    expect(route.revision).toBe(1)
    const [lon, lat] = route.line.at(-1)!
    expect(distanceM({ lat, lon }, RUNWAY_08_HOLD)).toBeLessThan(5)
  })

  it('publishes nothing new while nothing changes: the same boxes again, the aircraft standing still', () => {
    const w = setup()
    w.telemetry(ON_D)
    w.clearance(D_B7_A)
    const count = w.published.length
    w.clearance(D_B7_A)
    w.telemetry([5, ON_D[1], ON_D[2], ON_D[3], 0, 'taxi'])
    w.telemetry([6, ON_D[1], ON_D[2], ON_D[3], 0, 'taxi'])
    expect(w.published).toHaveLength(count)
  })

  it('shortens the line as the aircraft drives along it, a new revision each time', () => {
    const w = setup()
    const samples = REPLAY_227 as Sample[]
    w.telemetry(samples[0])
    w.clearance(D_B7_A)
    const first = w.last()!
    for (const s of samples.slice(0, 80)) w.telemetry(s)
    const later = w.last()!
    expect(later.revision).toBeGreaterThan(first.revision)
    expect(later.clearance).toEqual(first.clearance)
  })

  it('replaces the line with the one for a new clearance', () => {
    const w = setup()
    w.telemetry(ON_D)
    w.clearance(D_B7_A)
    const before = w.last()!
    w.clearance(D_A3_A)
    const after = w.last()!
    expect(after.clearance.taxiways).toEqual(['D', 'A3', 'A'])
    expect(after.revision).toBeGreaterThan(before.revision)
  })

  it('starts a clearance read before the aircraft had a position from the first position that arrives', () => {
    const w = setup()
    w.clearance(D_B7_A)
    expect(w.last()).toMatchObject({ kind: null, line: [] })
    w.telemetry(ON_D)
    expect(w.last()).toMatchObject({ kind: 'exact' })
    expect(w.last()!.line.length).toBeGreaterThan(2)
  })

  it('takes a clearance the hub already held when the service starts (the app started mid-taxi)', () => {
    const hub = new LiveHub()
    hub.publish('simTelemetry', {
      latitude: ON_D[1],
      longitude: ON_D[2],
      headingTrueDeg: 90,
      groundSpeedMs: 5
    } as SimTelemetry)
    hub.publish('beyondAtcState', { ...EMPTY_BEYONDATC_STATE, infoBoxes: D_B7_A })
    const published: (TaxiRoute | null)[] = []
    hub.subscribe((topic, payload) => {
      if (topic === 'taxiRoute') published.push(payload as TaxiRoute | null)
    })
    new TaxiRouteService({
      hub,
      navdata: {
        getTaxiNetwork: () => ZJSY,
        listRunways: () => [],
        getStands: () => Promise.resolve([]),
        onAirportRefreshed: () => () => undefined
      },
      shownFlight: () => ({ flightId: 1, depIcao: 'ZJSY', arrIcao: 'VHHH', ofpJson: null }),
      active: () => undefined,
      now: () => 0
    }).start()
    expect(published.at(-1)).toMatchObject({ kind: 'exact', icao: 'ZJSY' })
  })

  it('logs how the line was made', () => {
    const w = setup()
    w.telemetry(ON_D)
    w.clearance(D_B7_A)
    const lines = vi.mocked(logger.info).mock.calls.map((c) => String(c[0]))
    expect(
      lines.some((l) =>
        /\[taxi\] ZJSY taxi route traced \(exact\).*taxiways D B7 A.*points in \d+ ms/.test(l)
      )
    ).toBe(true)
  })
})

describe('TaxiRouteService: nothing is drawn when no route is found', () => {
  it('publishes the clearance with no line when the airport has no taxi network', () => {
    const w = setup({ networks: {} })
    w.telemetry(ON_D)
    w.clearance(D_B7_A)
    expect(w.last()).toMatchObject({
      kind: null,
      line: [],
      clearance: { taxiways: ['D', 'B7', 'A'] }
    })
    expect(
      vi.mocked(logger.info).mock.calls.some((c) => String(c[0]).includes('no taxi network cached'))
    ).toBe(true)
  })

  it('traces the line when the taxi network arrives later', () => {
    const w = setup({ networks: {} })
    w.telemetry(ON_D)
    w.clearance(D_B7_A)
    expect(w.last()).toMatchObject({ kind: null })
    w.state.networks.ZJSY = ZJSY
    w.refresh('ZJSY')
    expect(w.last()).toMatchObject({ kind: 'exact' })
  })

  it('does not trace again for another airport, or when a refresh brings the same network', () => {
    const w = setup()
    w.telemetry(ON_D)
    w.clearance(D_B7_A)
    const traces = vi.mocked(logger.info).mock.calls.length
    w.refresh('EGLL')
    w.refresh('ZJSY')
    expect(vi.mocked(logger.info).mock.calls).toHaveLength(traces)
  })

  it('draws nothing for a clearance that names more than 20 taxiways', () => {
    const w = setup()
    w.telemetry(ON_D)
    const boxes = Array.from({ length: 21 }, (_, i): BeyondAtcInfoBox => ({
      title: `Taxi Via ${i + 1}`,
      info: i % 2 ? 'A' : 'D'
    }))
    w.clearance(boxes)
    expect(w.last()).toMatchObject({ kind: null, line: [] })
  })

  it('publishes the clearance with no airport and no line when no flight is shown to say which airports it can be for', () => {
    const w = setup({ flight: undefined })
    w.telemetry(ON_D)
    w.clearance(D_B7_A)
    expect(w.last()).toMatchObject({ flightId: null, icao: '', kind: null, line: [] })
  })
})

describe('TaxiRouteService: the line goes when the aircraft has left the ground, or the flight changes', () => {
  it('drops the departure clearance from the takeoff roll on, and takes the next one', () => {
    const w = setup({ active: { flightId: 1, phase: 'taxi' } })
    w.telemetry(ON_D)
    w.clearance(D_B7_A)
    expect(w.last()).toMatchObject({ kind: 'exact' })
    w.telemetry([60, 18.3017, 109.3964, 80, 30, 'takeoff'])
    expect(w.published.at(-1)).toBeNull()
    w.telemetry([120, 18.3, 109.3, 80, 90, 'climb'])
    expect(w.published.at(-1)).toBeNull()
    // The same boxes stay up in BeyondATC, and are not taken again.
    w.clearance(D_B7_A)
    expect(w.published.at(-1)).toBeNull()
  })

  it("drops another flight's clearance when tracking moves to a different flight", () => {
    const w = setup({ active: { flightId: 1, phase: 'taxi' } })
    w.telemetry(ON_D)
    w.clearance(D_B7_A)
    expect(w.last()).toMatchObject({ flightId: 1, kind: 'exact' })
    w.state.active = { flightId: 2, phase: 'taxi' }
    w.telemetry([5, ON_D[1], ON_D[2], 90, 5, 'taxi'])
    expect(w.published.at(-1)).toBeNull()
  })
})

describe('TaxiRouteService: re-routing, on the recorded taxis', () => {
  /** Feeds a recorded taxi sample by sample, as live, with the clearance given at the first one. */
  function replay(samples: Sample[], boxes: BeyondAtcInfoBox[], network: NavdataTaxiSegment[], icao: string) {
    const w = setup({
      networks: { [icao]: network },
      flight: { flightId: 1, depIcao: icao, arrIcao: 'VHHH', ofpJson: null },
      active: { flightId: 1, phase: 'taxi' }
    })
    const rerouteTimes: number[] = []
    let at = 0
    vi.mocked(logger.info).mockImplementation((message: unknown) => {
      if (String(message).includes('re-routed')) rerouteTimes.push(at)
    })
    w.telemetry(samples[0])
    w.clearance(boxes)
    const lines: { t: number; line: [number, number][] }[] = []
    for (const s of samples) {
      at = s[0]
      w.telemetry(s)
      const published = w.last()
      if (published) lines.push({ t: s[0], line: published.line })
    }
    return { w, lines, rerouteTimes }
  }

  it('flight 227 (ZJSY, wrong-way pushback): re-routes within 10 s of starting to taxi the wrong way, and the line ends where the pilot held', () => {
    const samples = REPLAY_227 as Sample[]
    const { lines, rerouteTimes } = replay(samples, D_B7_A, ZJSY, 'ZJSY')
    const taxiStart = samples.find((s) => s[5] === 'taxi')![0]
    expect(rerouteTimes.length).toBeGreaterThan(0)
    expect(rerouteTimes[0] - taxiStart).toBeLessThanOrEqual(10)
    for (const [i, { line }] of lines.entries()) {
      // Every line the service publishes ends at A's runway 08 hold short, the clearance's own end.
      const [lon, lat] = line.at(-1)!
      if (i > 3) expect(distanceM({ lat, lon }, RUNWAY_08_HOLD)).toBeLessThan(30)
    }
  })

  it('flight 253 (ZJSY, D, A3, A driven D, B5, B, A1): the line follows the pilot rather than fighting him', () => {
    const samples = REPLAY_253 as Sample[]
    const { lines, rerouteTimes } = replay(samples, D_A3_A, ZJSY, 'ZJSY')
    expect(lines.length).toBeGreaterThan(10)
    expect(rerouteTimes.length).toBeGreaterThan(0)
    // Re-routes settle: a handful, not one every few seconds.
    expect(rerouteTimes.length).toBeLessThanOrEqual(6)
    const lastTaxi = samples.filter((s) => s[5] === 'taxi').at(-1)!
    const end = lines
      .filter((l) => l.t <= lastTaxi[0])
      .at(-1)!
      .line.at(-1)!
    // The pilot held at A1, the runway 08 hold short of A, as cleared.
    expect(distanceM({ lat: end[1], lon: end[0] }, RUNWAY_08_HOLD)).toBeLessThan(60)
  })

  it('flight 225 (YBBN, taxiing away from the first trace): the first line has no hairpin, and the last leads to where the aircraft held', () => {
    // The service knows the heading when the clearance arrives, so the first line already starts the way the aircraft is going and no
    // re-route is needed (the taxi code's own test withholds the heading to force one).
    const samples = REPLAY_225 as Sample[]
    const { lines } = replay(samples, C9_B9_A9, YBBN, 'YBBN')
    const bearing = ([aLon, aLat]: [number, number], [bLon, bLat]: [number, number]): number =>
      ((Math.atan2((bLon - aLon) * Math.cos((aLat * Math.PI) / 180), bLat - aLat) * 180) / Math.PI + 360) %
      360
    const first = lines[0].line
    const turns = first
      .slice(1, -1)
      .map((p, i) => angleBetweenDeg(bearing(first[i], p), bearing(p, first[i + 2])))
    expect(Math.max(...turns)).toBeLessThan(120)
    const end = lines.at(-1)!.line.at(-1)!
    const closest = Math.min(
      ...samples.map(([, lat, lon]) => distanceM({ lat, lon }, { lat: end[1], lon: end[0] }))
    )
    expect(closest).toBeLessThan(40)
  })
})

describe('TaxiRouteService: more clearance shapes, and the pushback', () => {
  it('traces the first half of a split arrival clearance, "taxi via C7, Y, F, hold short of runway 07C" (VHHH), to the hold short on F', () => {
    const w = setup({
      networks: { VHHH: VHHH_HOLD, ZJSY },
      flight: { flightId: 1, depIcao: 'ZJSY', arrIcao: 'VHHH', ofpJson: null },
      active: { flightId: 1, phase: 'taxi' }
    })
    // The top of C7, just off 07L, as the aircraft is when the clearance comes.
    w.telemetry([0, 22.3267351, 113.9016593, 90, 5, 'taxi'])
    w.clearance([
      { title: 'Taxi to Ramp', info: 'Ramp W122' },
      { title: 'Taxi Via 1', info: 'C7' },
      { title: 'Taxi Via 2', info: 'Y' },
      { title: 'Taxi Via 3', info: 'F' },
      { title: 'Hold Short', info: '07C' }
    ])
    expect(w.last()).toMatchObject({
      icao: 'VHHH',
      kind: 'exact',
      clearance: { holdShortRunway: '07C', holdingPoint: null }
    })
    const [lon, lat] = w.last()!.line.at(-1)!
    expect(distanceM({ lat, lon }, { lat: 22.32092, lon: 113.92363 })).toBeLessThan(30)
  })

  it('does not re-route during pushback, when the aircraft moves tail first', () => {
    const samples = REPLAY_227 as Sample[]
    const pushback = samples.filter((s) => s[5] === 'pushback')
    expect(pushback.length).toBeGreaterThan(5)
    const w = setup({ active: { flightId: 1, phase: 'pushback' } })
    w.telemetry(pushback[0])
    w.clearance(D_B7_A)
    for (const s of pushback) w.telemetry(s)
    expect(vi.mocked(logger.info).mock.calls.some((c) => String(c[0]).includes('re-routed'))).toBe(false)
  })
})

describe('TaxiRouteService: stands', () => {
  const STAND: NavdataStand = {
    name: 'N32',
    number: 32,
    suffix: 0,
    headingDeg: 0,
    lat: 18.3075447,
    lon: 109.4041842
  }
  const TO_GATE: BeyondAtcInfoBox[] = [
    { title: 'Taxi to Gate', info: 'N32' },
    { title: 'Taxi Via 1', info: 'D' }
  ]

  it('traces to the join of the last taxiway first, then again when the stands arrive', async () => {
    const w = setup({
      flight: { flightId: 1, depIcao: 'VHHH', arrIcao: 'ZJSY', ofpJson: null },
      stands: { ZJSY: [STAND] }
    })
    w.telemetry(ON_D)
    w.clearance(TO_GATE)
    const before = w.last()!
    expect(before).toMatchObject({ icao: 'ZJSY', clearance: { stand: 'N32' } })
    await vi.waitFor(() => expect(w.last()!.revision).toBeGreaterThan(before.revision))
    const end = w.last()!.line.at(-1)!
    expect(distanceM({ lat: end[1], lon: end[0] }, STAND)).toBeLessThan(80)
  })

  it('asks for the stands again at a later trace when the first ask found none', async () => {
    const w = setup({ flight: { flightId: 1, depIcao: 'VHHH', arrIcao: 'ZJSY', ofpJson: null } })
    const asked = vi.fn((icao: string) =>
      Promise.resolve(icao === 'ZJSY' && asked.mock.calls.length > 1 ? [STAND] : [])
    )
    const hub = new LiveHub()
    const published: (TaxiRoute | null)[] = []
    hub.subscribe((topic, payload) => {
      if (topic === 'taxiRoute') published.push(payload as TaxiRoute | null)
    })
    const listeners = new Set<(icao: string) => void>()
    new TaxiRouteService({
      hub,
      navdata: {
        getTaxiNetwork: () => ZJSY,
        listRunways: () => [],
        getStands: asked,
        onAirportRefreshed: (l) => {
          listeners.add(l)
          return () => listeners.delete(l)
        }
      },
      shownFlight: () => w.state.flight,
      active: () => undefined,
      now: () => 0
    }).start()
    hub.publish('simTelemetry', {
      latitude: ON_D[1],
      longitude: ON_D[2],
      headingTrueDeg: 90,
      groundSpeedMs: 5
    } as SimTelemetry)
    hub.publish('beyondAtcState', { ...EMPTY_BEYONDATC_STATE, infoBoxes: TO_GATE })
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(1))
    // The airport's data is fetched later (the sim came up): the service looks again.
    listeners.forEach((l) => l('ZJSY'))
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(2))
    expect(published.at(-1)).toMatchObject({ clearance: { stand: 'N32' } })
  })
})

describe('TaxiRouteService: failures stay inside it', () => {
  it('logs a failure and goes on with the next sample and the next clearance', () => {
    const w = setup()
    w.telemetry(ON_D)
    let broken = true
    const original = w.state.networks
    Object.defineProperty(w.state, 'networks', {
      get: () => {
        if (broken) throw new Error('database locked')
        return original
      }
    })
    w.clearance(D_B7_A)
    expect(
      vi
        .mocked(logger.warn)
        .mock.calls.some((c) => String(c[0]).includes('[taxi] beyondAtcState not handled'))
    ).toBe(true)
    broken = false
    w.clearance(D_A3_A)
    expect(w.last()).toMatchObject({ clearance: { taxiways: ['D', 'A3', 'A'] }, kind: 'exact' })
  })

  it('stops following the hub when stopped', () => {
    const w = setup()
    w.telemetry(ON_D)
    w.stop()
    w.clearance(D_B7_A)
    expect(w.published).toEqual([])
  })
})
