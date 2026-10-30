import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { LatLon } from '@shared/geo'
import type {
  NetworkAtc,
  NetworkControllers,
  NetworkTraffic,
  OnlineNetworkSettings,
  OnlineStatus,
  TrafficLayers
} from '@shared/ipc'
import {
  ATIS_FRESH_MS,
  ATIS_WAIT_MS,
  FAILURE_LOG_INTERVAL_MS,
  FEED_TIMEOUT_MS,
  NetworkFeedService,
  STALE_AFTER_MS,
  type FeedTimers
} from './NetworkFeedService'
import { REAL_FEED_URLS, type FeedUrls } from './feed-urls'
import { parseAreaData, type AreaData } from './atc-areas'
import type { TrafficSwitches } from './online-settings'

const REAL_AREAS = parseAreaData(readFileSync(join(__dirname, '../../../resources/atc-areas.json'), 'utf8'))
const AIRPORTS: Record<string, LatLon> = {
  EGLL: { lat: 51.4706, lon: -0.4619 },
  EGKK: { lat: 51.1481, lon: -0.1903 }
}

const T0 = Date.parse('2026-10-24T21:05:06Z')
/** Over EGLL, where the busy fixture's aircraft are. */
const EGLL: LatLon = { lat: 51.4706, lon: -0.4619 }

function fixtureText(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', name), 'utf8')
}

/** A clock and timers the test moves by hand. */
class FakeClock implements FeedTimers {
  nowMs = T0
  private nextId = 1
  private readonly pending = new Map<number, { at: number; callback: () => void }>()
  set = (callback: () => void, ms: number): unknown => {
    const id = this.nextId++
    this.pending.set(id, { at: this.nowMs + ms, callback })
    return id
  }
  clear = (handle: unknown): void => {
    this.pending.delete(handle as number)
  }
  get pendingCount(): number {
    return this.pending.size
  }
  /** Moves time forward, running timers as they fall due, letting promises settle between them. */
  async advance(ms: number): Promise<void> {
    const end = this.nowMs + ms
    for (;;) {
      const due = [...this.pending.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      this.pending.delete(due[0])
      this.nowMs = Math.max(this.nowMs, due[1].at)
      due[1].callback()
      await settle()
    }
    this.nowMs = end
  }
}

/** Lets pending promise callbacks run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
}

function okResponse(body: string): Response {
  return new Response(body, { status: 200 })
}

describe('NetworkFeedService', () => {
  let clock: FakeClock
  let published: {
    traffic: NetworkTraffic[]
    layers: TrafficLayers[]
    status: OnlineStatus[]
    controllers: NetworkControllers[]
    atc: NetworkAtc[]
  }
  let settings: OnlineNetworkSettings
  let switches: TrafficSwitches
  let areaData: AreaData | null
  let centre: LatLon | null
  let tracked: { departure: string; arrival: string; alternate?: string | null } | null
  let airborne: boolean
  let pretend: string | null
  const statuses = (): OnlineStatus[] => published.status
  let fetchMock: ReturnType<typeof vi.fn>
  let warn: Mock<(message: string) => void>
  let urls: FeedUrls
  let service: NetworkFeedService
  let told: TrafficLayers[]

  function build(): void {
    service = new NetworkFeedService({
      hub: {
        publish: ((topic: string, payload: unknown) => {
          if (topic === 'networkTraffic') published.traffic.push(payload as NetworkTraffic)
          if (topic === 'trafficLayers') published.layers.push(payload as TrafficLayers)
          if (topic === 'onlineStatus') published.status.push(payload as OnlineStatus)
          if (topic === 'networkControllers') published.controllers.push(payload as NetworkControllers)
          if (topic === 'networkAtc') published.atc.push(payload as NetworkAtc)
        }) as never
      },
      fetch: fetchMock as unknown as typeof fetch,
      now: () => clock.nowMs,
      timers: clock,
      urls,
      appVersion: '1.6.0',
      settings: () => settings,
      switches: () => switches,
      saveSwitches: (next) => {
        switches = next
      },
      atcAreas: () => areaData,
      airportAt: (icao) => AIRPORTS[icao] ?? null,
      centre: () => centre,
      trackedFlight: () => tracked,
      isAirborne: () => airborne,
      pretendCallsign: () => pretend,
      onLayers: (layers) => told.push(layers),
      log: { warn }
    })
  }

  const last = (): NetworkTraffic | undefined => published.traffic.at(-1)

  beforeEach(() => {
    clock = new FakeClock()
    published = { traffic: [], layers: [], status: [], controllers: [], atc: [] }
    areaData = REAL_AREAS
    settings = {
      network: 'vatsim',
      vatsimCid: null,
      ivaoVid: null,
      keepBeyondAtcOnline: false,
      simTrafficButton: true
    }
    switches = { networkOn: true, simOn: false, atcOn: false }
    centre = EGLL
    tracked = null
    airborne = false
    pretend = null
    fetchMock = vi.fn(() => Promise.resolve(okResponse(fixtureText('vatsim-busy.json'))))
    warn = vi.fn()
    told = []
    urls = { vatsimStatus: null, vatsimData: 'http://feed.test/vatsim', ivao: 'http://feed.test/ivao' }
    build()
  })

  describe('publishing', () => {
    it('says the layer is off, without a request, while the switch is off', async () => {
      switches = { networkOn: false, simOn: false, atcOn: false }
      service.start()
      await clock.advance(60_000)
      expect(last()).toEqual({ network: 'vatsim', state: 'off', aircraft: [] })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(published.layers.at(-1)).toMatchObject({ networkOn: false, drawNetwork: false })
    })

    it('says no network is chosen, without a request', async () => {
      settings = {
        network: null,
        vatsimCid: null,
        ivaoVid: null,
        keepBeyondAtcOnline: false,
        simTrafficButton: true
      }
      service.start()
      await clock.advance(60_000)
      expect(last()).toEqual({ network: null, state: 'noNetwork', aircraft: [] })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('makes no request at all for IVAO without a VID, however long it runs', async () => {
      settings = {
        network: 'ivao',
        vatsimCid: null,
        ivaoVid: null,
        keepBeyondAtcOnline: false,
        simTrafficButton: true
      }
      service.start()
      await clock.advance(10 * 60_000)
      expect(last()).toEqual({ network: 'ivao', state: 'needsVid', aircraft: [] })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('reads the feed and publishes the aircraft near the centre, nearest first', async () => {
      service.start()
      await settle()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(last()?.state).toBe('shown')
      expect(last()?.aircraft.length).toBeGreaterThan(20)
      expect(last()?.aircraft.length).toBeLessThanOrEqual(400)
      expect(JSON.stringify(last())).not.toContain('Test Pilot')
    })

    it('leaves out the pilot’s own aircraft by their CID', async () => {
      const everyone = (await (async () => {
        service.start()
        await settle()
        return last()?.aircraft.length ?? 0
      })()) as number
      const raw = JSON.parse(fixtureText('vatsim-busy.json')) as {
        pilots: { cid: number; callsign: string }[]
      }
      const own = raw.pilots[0]
      expect(own).toBeDefined()
      service.stop()
      published.traffic = []
      settings = {
        network: 'vatsim',
        vatsimCid: String(own?.cid),
        ivaoVid: null,
        keepBeyondAtcOnline: false,
        simTrafficButton: true
      }
      clock = new FakeClock()
      build()
      service.start()
      await settle()
      expect(last()?.aircraft.length).toBe(everyone - 1)
      expect(last()?.aircraft.some((a) => a.callsign === own?.callsign)).toBe(false)
    })

    it('shows the whole network while there is no position, and narrows to the aircraft at once when one arrives', async () => {
      // Callum, 2026-10-25: the button shows traffic whatever else is known. The busy capture's 150 pilots are all around London.
      centre = null
      service.start()
      await settle()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(last()?.state).toBe('shown')
      expect(last()?.aircraft).toHaveLength(150)
      centre = { lat: 22.31, lon: 113.92 }
      service.onPositionChanged()
      // From the snapshot it already has: nobody within 250 nm of Hong Kong, and no new request.
      expect(last()).toEqual({ network: 'vatsim', state: 'shown', aircraft: [] })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('keeps reading the feed for the whole network while there is no position, every 15 s', async () => {
      centre = null
      service.start()
      await settle()
      await clock.advance(15_000)
      await settle()
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('does not publish again on a position change once the traffic is around a position', async () => {
      service.start()
      await settle()
      const before = published.traffic.length
      service.onPositionChanged()
      expect(published.traffic.length).toBe(before)
    })

    it('publishes the layers at start, and again when the switch is turned on from any screen', async () => {
      switches = { networkOn: false, simOn: false, atcOn: false }
      service.start()
      expect(published.layers.at(-1)).toMatchObject({ networkOn: false })
      service.setNetworkOn(true)
      expect(switches.networkOn).toBe(true)
      expect(published.layers.at(-1)).toMatchObject({ networkOn: true, drawNetwork: true })
      await settle()
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('stops reading when the switch is turned off, and shows the layer off', async () => {
      service.start()
      await settle()
      service.setNetworkOn(false)
      await clock.advance(5 * 60_000)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(last()?.state).toBe('off')
    })

    it('draws only the network layer when both switches are stored on, and shows the sim switch off', async () => {
      switches = { networkOn: true, simOn: true, atcOn: false }
      service.start()
      expect(published.layers.at(-1)).toMatchObject({
        drawNetwork: true,
        simOn: false,
        drawSim: false
      })
    })
  })

  describe('the sim layer', () => {
    it('draws when its switch is on and the network layer is not, and tells the sim reader', () => {
      switches = { networkOn: false, simOn: false, atcOn: false }
      service.start()
      service.setSimOn(true)
      expect(switches).toEqual({ networkOn: false, simOn: true, atcOn: false })
      expect(published.layers.at(-1)).toMatchObject({ drawSim: true, drawNetwork: false, simOn: true })
      expect(told.at(-1)?.drawSim).toBe(true)
      service.setSimOn(false)
      expect(told.at(-1)?.drawSim).toBe(false)
    })

    it('and the network layer switch each other off: turning one on turns the other off, and it stays off (Callum, 2026-10-29)', () => {
      switches = { networkOn: false, simOn: true, atcOn: false }
      service.start()
      expect(told.at(-1)?.drawSim).toBe(true)
      service.setNetworkOn(true)
      expect(switches).toEqual({ networkOn: true, simOn: false, atcOn: false })
      expect(told.at(-1)).toMatchObject({ drawNetwork: true, drawSim: false, simOn: false })
      service.setSimOn(true)
      expect(switches).toEqual({ networkOn: false, simOn: true, atcOn: false })
      expect(told.at(-1)).toMatchObject({ drawNetwork: false, drawSim: true })
      // Turning one off leaves the other as it is.
      service.setSimOn(false)
      expect(switches).toEqual({ networkOn: false, simOn: false, atcOn: false })
      service.setNetworkOn(true)
      service.setNetworkOn(false)
      expect(switches).toEqual({ networkOn: false, simOn: false, atcOn: false })
    })

    it('is neither offered nor drawn once its button is switched off in Settings, and the sim reader is told to stop', () => {
      switches = { networkOn: false, simOn: true, atcOn: false }
      service.start()
      expect(told.at(-1)).toMatchObject({ simOffered: true, drawSim: true })
      settings = { ...settings, simTrafficButton: false }
      service.refresh()
      expect(published.layers.at(-1)).toMatchObject({ simOn: true, simOffered: false, drawSim: false })
      expect(told.at(-1)?.drawSim).toBe(false)
      settings = { ...settings, simTrafficButton: true }
      service.refresh()
      expect(told.at(-1)).toMatchObject({ simOffered: true, drawSim: true })
    })
  })

  describe('the request', () => {
    it('sends WingLog’s User-Agent and gzip, with a way to cancel it', async () => {
      service.start()
      await settle()
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('http://feed.test/vatsim')
      expect(init.headers).toEqual({
        'User-Agent': 'WingLog/1.6.0 (+https://github.com/Catalyst4K/WingLog)',
        'Accept-Encoding': 'gzip'
      })
      expect(init.signal).toBeInstanceOf(AbortSignal)
    })

    it('gives up after 10 s', async () => {
      fetchMock.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          })
      )
      service.start()
      await clock.advance(FEED_TIMEOUT_MS - 1)
      expect(warn).not.toHaveBeenCalled()
      await clock.advance(1)
      expect(warn).toHaveBeenCalledTimes(1)
    })

    it('reads IVAO from its own address', async () => {
      settings = {
        network: 'ivao',
        vatsimCid: null,
        ivaoVid: '900001',
        keepBeyondAtcOnline: false,
        simTrafficButton: true
      }
      fetchMock.mockImplementation(() => Promise.resolve(okResponse(fixtureText('ivao-synthetic.json'))))
      service.start()
      await settle()
      expect(fetchMock.mock.calls[0]?.[0]).toBe('http://feed.test/ivao')
      expect(last()?.state).toBe('shown')
    })

    it('leaves out the pilot’s own VID on IVAO', async () => {
      settings = {
        network: 'ivao',
        vatsimCid: null,
        ivaoVid: '900001',
        keepBeyondAtcOnline: false,
        simTrafficButton: true
      }
      fetchMock.mockImplementation(() => Promise.resolve(okResponse(fixtureText('ivao-synthetic.json'))))
      service.start()
      await settle()
      expect(last()?.aircraft.some((a) => a.callsign === 'TST001')).toBe(false)
      expect(last()?.aircraft.some((a) => a.callsign === 'TST002')).toBe(true)
    })

    it('finds VATSIM’s data address from its status page once, then reuses it', async () => {
      urls = { ...REAL_FEED_URLS }
      fetchMock.mockImplementation((url: string) =>
        Promise.resolve(
          okResponse(
            url === REAL_FEED_URLS.vatsimStatus
              ? JSON.stringify({ data: { v3: ['https://data.vatsim.net/v3/vatsim-data.json'] } })
              : fixtureText('vatsim-busy.json')
          )
        )
      )
      build()
      service.start()
      await settle()
      await clock.advance(15_000)
      await settle()
      const requested = fetchMock.mock.calls.map((call) => call[0])
      expect(requested.filter((u) => u === REAL_FEED_URLS.vatsimStatus)).toHaveLength(1)
      expect(requested.filter((u) => u === REAL_FEED_URLS.vatsimData)).toHaveLength(2)
    })

    it('uses the fixed data address when the status page is unreadable or names another host', async () => {
      urls = { ...REAL_FEED_URLS }
      fetchMock.mockImplementation((url: string) =>
        Promise.resolve(
          okResponse(
            url === REAL_FEED_URLS.vatsimStatus
              ? JSON.stringify({ data: { v3: ['https://evil.example/data.json'] } })
              : fixtureText('vatsim-busy.json')
          )
        )
      )
      build()
      service.start()
      await settle()
      expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
        REAL_FEED_URLS.vatsimStatus,
        REAL_FEED_URLS.vatsimData
      ])
    })

    it('refuses a body that is not a feed', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(okResponse('<html>502</html>')))
      service.start()
      await settle()
      expect(warn).toHaveBeenCalledWith('[online] vatsim feed failed: not JSON')
      fetchMock.mockImplementation(() => Promise.resolve(okResponse('{"pilots":"x"}')))
      await clock.advance(30_000)
      expect(warn).toHaveBeenCalledTimes(1)
    })
  })

  describe('timing', () => {
    it('refreshes every 15 s while the layer is on, and not faster', async () => {
      service.start()
      await settle()
      await clock.advance(14_999)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      await clock.advance(1)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      await clock.advance(30_000)
      expect(fetchMock).toHaveBeenCalledTimes(4)
    })

    it('does not start another request while one is still in flight', async () => {
      let release: (response: Response) => void = () => undefined
      fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (release = resolve)))
      service.start()
      await clock.advance(9_000)
      service.refresh()
      service.refresh()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      release(okResponse(fixtureText('vatsim-busy.json')))
      await settle()
      expect(last()?.state).toBe('shown')
    })

    it('does not beat the 15 s floor by switching the layer off and on', async () => {
      service.start()
      await settle()
      service.setNetworkOn(false)
      await clock.advance(3_000)
      service.setNetworkOn(true)
      await settle()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      await clock.advance(12_000)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('shows the cached aircraft at once when the layer is switched back on', async () => {
      service.start()
      await settle()
      service.setNetworkOn(false)
      service.setNetworkOn(true)
      expect(last()?.state).toBe('shown')
      expect(last()?.aircraft.length).toBeGreaterThan(0)
    })

    it('drops the old network’s aircraft when the network changes', async () => {
      service.start()
      await settle()
      settings = {
        network: 'ivao',
        vatsimCid: null,
        ivaoVid: null,
        keepBeyondAtcOnline: false,
        simTrafficButton: true
      }
      service.refresh()
      expect(last()).toEqual({ network: 'ivao', state: 'needsVid', aircraft: [] })
      settings = {
        network: 'ivao',
        vatsimCid: null,
        ivaoVid: '900001',
        keepBeyondAtcOnline: false,
        simTrafficButton: true
      }
      fetchMock.mockImplementation(() => Promise.resolve(okResponse(fixtureText('ivao-synthetic.json'))))
      service.refresh()
      expect(last()?.aircraft).toEqual([])
    })

    it('ignores the answer to a request for a network the pilot has since left', async () => {
      let release: (response: Response) => void = () => undefined
      fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (release = resolve)))
      service.start()
      settings = {
        network: 'ivao',
        vatsimCid: null,
        ivaoVid: null,
        keepBeyondAtcOnline: false,
        simTrafficButton: true
      }
      service.refresh()
      release(okResponse(fixtureText('vatsim-busy.json')))
      await settle()
      expect(last()).toEqual({ network: 'ivao', state: 'needsVid', aircraft: [] })
    })
  })

  describe('failures', () => {
    beforeEach(() => {
      service.start()
    })

    it('keeps the last aircraft for 45 s, then says the feed is unavailable with none', async () => {
      await settle()
      fetchMock.mockImplementation(() => Promise.resolve(new Response('', { status: 503 })))
      await clock.advance(15_000)
      expect(last()?.state).toBe('shown')
      expect(last()?.aircraft.length).toBeGreaterThan(0)
      await clock.advance(STALE_AFTER_MS - 15_000 - 1)
      expect(last()?.state).toBe('shown')
      await clock.advance(1)
      expect(last()).toEqual({ network: 'vatsim', state: 'unavailable', aircraft: [] })
    })

    it('recovers when the feed comes back', async () => {
      await settle()
      fetchMock.mockImplementation(() => Promise.resolve(new Response('', { status: 503 })))
      await clock.advance(120_000)
      expect(last()?.state).toBe('unavailable')
      fetchMock.mockImplementation(() => Promise.resolve(okResponse(fixtureText('vatsim-busy.json'))))
      await clock.advance(300_000)
      expect(last()?.state).toBe('shown')
      expect(last()?.aircraft.length).toBeGreaterThan(0)
    })

    it('says unavailable 45 s after starting when the feed never worked', async () => {
      service.stop()
      published.traffic = []
      fetchMock.mockImplementation(() => Promise.reject(new Error('offline')))
      clock = new FakeClock()
      build()
      service.start()
      await settle()
      expect(last()?.state).toBe('shown')
      await clock.advance(STALE_AFTER_MS)
      expect(last()?.state).toBe('unavailable')
    })

    it('backs off 30 s, then 60 s, after failures', async () => {
      await settle()
      fetchMock.mockImplementation(() => Promise.resolve(new Response('', { status: 500 })))
      await clock.advance(15_000)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      await clock.advance(29_999)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      await clock.advance(1)
      expect(fetchMock).toHaveBeenCalledTimes(3)
      await clock.advance(59_999)
      expect(fetchMock).toHaveBeenCalledTimes(3)
      await clock.advance(1)
      expect(fetchMock).toHaveBeenCalledTimes(4)
    })

    it('logs the first failure and then at most once every 10 minutes, naming the network and the status', async () => {
      await settle()
      fetchMock.mockImplementation(() => Promise.resolve(new Response('', { status: 500 })))
      await clock.advance(15_000)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith('[online] vatsim feed failed: HTTP 500')
      await clock.advance(FAILURE_LOG_INTERVAL_MS - 16_000)
      expect(warn).toHaveBeenCalledTimes(1)
      await clock.advance(6 * 60_000)
      expect(warn).toHaveBeenCalledTimes(2)
    })

    it('never logs a callsign, name or member number from the feed', async () => {
      const raw = JSON.parse(fixtureText('vatsim-busy.json')) as {
        pilots: { callsign: string; cid: number }[]
      }
      const secrets = raw.pilots.slice(0, 20).flatMap((p) => [p.callsign, String(p.cid), 'Test Pilot'])
      fetchMock.mockImplementation(() =>
        Promise.resolve(okResponse(JSON.stringify({ pilots: 'x', note: secrets.join(' ') })))
      )
      await clock.advance(5 * 60_000)
      await settle()
      for (const call of warn.mock.calls)
        for (const secret of secrets) expect(String(call[0])).not.toContain(secret)
      expect(warn).toHaveBeenCalled()
    })
  })

  it('logs, without feed content, if handling a response throws', async () => {
    const publish = vi.fn((topic: string, payload: unknown) => {
      if (topic === 'networkTraffic' && (payload as NetworkTraffic).aircraft.length > 0)
        throw new Error('Test Pilot NEAR1')
    })
    service = new NetworkFeedService({
      hub: { publish: publish as never },
      fetch: fetchMock as unknown as typeof fetch,
      now: () => clock.nowMs,
      timers: clock,
      urls,
      appVersion: '1.6.0',
      settings: () => settings,
      switches: () => switches,
      saveSwitches: () => undefined,
      atcAreas: () => areaData,
      airportAt: (icao) => AIRPORTS[icao] ?? null,
      centre: () => centre,
      trackedFlight: () => tracked,
      isAirborne: () => airborne,
      pretendCallsign: () => pretend,
      log: { warn }
    })
    service.start()
    await settle()
    expect(warn).toHaveBeenCalledWith('[online] handling a feed response failed')
  })

  describe("the pilot's own status", () => {
    /** A pilot in the busy fixture who has filed a plan, with the CID and plan the status should report. */
    function planned(): { cid: number; callsign: string; departure: string; arrival: string } {
      const raw = JSON.parse(fixtureText('vatsim-busy.json')) as {
        pilots: {
          cid: number
          callsign: string
          flight_plan: { departure: string; arrival: string } | null
        }[]
      }
      const found = raw.pilots.find((p) => p.flight_plan?.departure && p.flight_plan.arrival)!
      return {
        cid: found.cid,
        callsign: found.callsign,
        departure: found.flight_plan!.departure,
        arrival: found.flight_plan!.arrival
      }
    }

    it('is unknown, with nothing fetched, while no flight is tracked and the layer is off', async () => {
      switches = { networkOn: false, simOn: false, atcOn: false }
      service.start()
      await clock.advance(5 * 60_000)
      expect(statuses().at(-1) ?? { state: 'unknown' }).toMatchObject({ state: 'unknown' })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('is looked up every 60 s while a flight is tracked, even with the traffic layer off', async () => {
      const self = planned()
      switches = { networkOn: false, simOn: false, atcOn: false }
      settings = {
        network: 'vatsim',
        vatsimCid: String(self.cid),
        ivaoVid: null,
        keepBeyondAtcOnline: false,
        simTrafficButton: true
      }
      tracked = { departure: self.departure, arrival: self.arrival }
      service.start()
      await settle()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(statuses().at(-1)).toMatchObject({ network: 'vatsim', state: 'online', callsign: self.callsign })
      await clock.advance(59_999)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      await clock.advance(1)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('is offline when the member number is not in the feed', async () => {
      const self = planned()
      settings = {
        network: 'vatsim',
        vatsimCid: '42',
        ivaoVid: null,
        keepBeyondAtcOnline: false,
        simTrafficButton: true
      }
      tracked = { departure: self.departure, arrival: self.arrival }
      service.start()
      await settle()
      expect(statuses().at(-1)).toMatchObject({ state: 'offline', callsign: null })
    })

    it('uses the same fetch for the traffic and the status: one request every 15 s, not two', async () => {
      const self = planned()
      settings = {
        network: 'vatsim',
        vatsimCid: String(self.cid),
        ivaoVid: null,
        keepBeyondAtcOnline: false,
        simTrafficButton: true
      }
      tracked = { departure: self.departure, arrival: self.arrival }
      service.start()
      await settle()
      await clock.advance(15_000)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(last()?.state).toBe('shown')
      expect(statuses().at(-1)?.state).toBe('online')
    })

    it("leaves the pilot's own aircraft out of the traffic, found by CID", async () => {
      const self = planned()
      settings = {
        network: 'vatsim',
        vatsimCid: String(self.cid),
        ivaoVid: null,
        keepBeyondAtcOnline: false,
        simTrafficButton: true
      }
      service.start()
      await settle()
      expect(last()?.aircraft.some((a) => a.callsign === self.callsign)).toBe(false)
    })

    it('leaves out the aircraft it found by plan and position when there is no CID', async () => {
      const self = planned()
      const raw = JSON.parse(fixtureText('vatsim-busy.json')) as {
        pilots: { callsign: string; latitude: number; longitude: number }[]
      }
      const own = raw.pilots.find((p) => p.callsign === self.callsign)!
      centre = { lat: own.latitude, lon: own.longitude }
      tracked = { departure: self.departure, arrival: self.arrival }
      service.start()
      await settle()
      expect(statuses().at(-1)).toMatchObject({ state: 'probably', callsign: self.callsign })
      expect(last()?.aircraft.some((a) => a.callsign === self.callsign)).toBe(false)
    })

    it('does nothing for IVAO without a VID, even with a flight tracked', async () => {
      settings = {
        network: 'ivao',
        vatsimCid: null,
        ivaoVid: null,
        keepBeyondAtcOnline: false,
        simTrafficButton: true
      }
      tracked = { departure: 'EGLL', arrival: 'LFPG' }
      service.start()
      await clock.advance(10 * 60_000)
      expect(fetchMock).not.toHaveBeenCalled()
      expect(statuses().at(-1) ?? { state: 'unknown' }).toMatchObject({ state: 'unknown' })
    })

    it('publishes only when the status changes', async () => {
      const self = planned()
      settings = {
        network: 'vatsim',
        vatsimCid: String(self.cid),
        ivaoVid: null,
        keepBeyondAtcOnline: false,
        simTrafficButton: true
      }
      tracked = { departure: self.departure, arrival: self.arrival }
      service.start()
      await settle()
      const count = statuses().length
      await clock.advance(45_000)
      expect(fetchMock.mock.calls.length).toBeGreaterThan(2)
      expect(statuses().length).toBe(count)
    })

    it('takes the pilot with the dev callsign to be the pilot', async () => {
      const self = planned()
      pretend = self.callsign
      tracked = { departure: 'ZZZZ', arrival: 'YYYY' }
      service.start()
      await settle()
      expect(statuses().at(-1)).toMatchObject({ state: 'online', callsign: self.callsign })
    })

    it('notices at take-off, from the position updates, without waiting for the next look at the feed', async () => {
      const self = planned()
      settings = {
        network: 'vatsim',
        vatsimCid: String(self.cid),
        ivaoVid: null,
        keepBeyondAtcOnline: false,
        simTrafficButton: true
      }
      tracked = { departure: self.departure, arrival: self.arrival }
      service.start()
      await settle()
      expect(service.takeOnlineSeen()).toBeNull() // online, but still on the ground
      airborne = true
      service.onPositionChanged()
      expect(service.takeOnlineSeen()).toEqual({ network: 'vatsim', callsign: self.callsign })
    })

    it('does not mark a flight online at take-off when the pilot was not online', async () => {
      const self = planned()
      settings = {
        network: 'vatsim',
        vatsimCid: '42',
        ivaoVid: null,
        keepBeyondAtcOnline: false,
        simTrafficButton: true
      }
      tracked = { departure: self.departure, arrival: self.arrival }
      service.start()
      await settle()
      airborne = true
      service.onPositionChanged()
      expect(service.takeOnlineSeen()).toBeNull()
    })

    it('remembers the network and callsign only while airborne, hands them over once, and forgets them on reset', async () => {
      const self = planned()
      settings = {
        network: 'vatsim',
        vatsimCid: String(self.cid),
        ivaoVid: null,
        keepBeyondAtcOnline: false,
        simTrafficButton: true
      }
      tracked = { departure: self.departure, arrival: self.arrival }
      service.start()
      await settle()
      expect(service.takeOnlineSeen()).toBeNull()
      airborne = true
      await clock.advance(15_000)
      expect(service.takeOnlineSeen()).toEqual({ network: 'vatsim', callsign: self.callsign })
      expect(service.takeOnlineSeen()).toBeNull()
      await clock.advance(15_000)
      service.resetOnlineSeen()
      expect(service.takeOnlineSeen()).toBeNull()
    })
  })

  describe("the controllers and ATIS at the flight's airports", () => {
    it("lists who is online at the tracked flight's airports, from the same fetch", async () => {
      tracked = { departure: 'EGLL', arrival: 'LFPG', alternate: 'EGKK' }
      service.start()
      await settle()
      const last = published.controllers.at(-1)
      expect(last?.network).toBe('vatsim')
      expect(last?.airports.map((a) => a.icao)).toEqual(['EGLL', 'LFPG', 'EGKK'])
      const heathrow = last?.airports[0]
      expect(heathrow?.stations.length).toBeGreaterThan(0)
      expect(heathrow?.stations.every((s) => /^\d{3}\.\d{3}$/.test(s.frequency))).toBe(true)
      expect(heathrow?.atis.length).toBeGreaterThan(0)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('lists no airports while no flight is tracked, and nothing was fetched for it', async () => {
      switches = { networkOn: false, simOn: false, atcOn: false }
      service.start()
      await settle()
      expect(published.controllers.at(-1) ?? { airports: [] }).toMatchObject({ airports: [] })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('publishes only when the list changes', async () => {
      tracked = { departure: 'EGLL', arrival: 'LFPG' }
      service.start()
      await settle()
      const count = published.controllers.length
      await clock.advance(45_000)
      expect(fetchMock.mock.calls.length).toBeGreaterThan(2)
      expect(published.controllers.length).toBe(count)
    })

    it('empties the list when the flight ends', async () => {
      tracked = { departure: 'EGLL', arrival: 'LFPG' }
      service.start()
      await settle()
      expect(published.controllers.at(-1)?.airports.length).toBe(2)
      tracked = null
      service.refresh()
      expect(published.controllers.at(-1)?.airports).toEqual([])
    })
  })

  describe('IVAO once its VID is cleared (Regulation D.2)', () => {
    beforeEach(() => {
      settings = {
        network: 'ivao',
        vatsimCid: null,
        ivaoVid: '900001',
        keepBeyondAtcOnline: false,
        simTrafficButton: true
      }
      fetchMock.mockImplementation(() => Promise.resolve(okResponse(fixtureText('ivao-synthetic.json'))))
      // TSTA is the synthetic feed's invented airport, with a tower, ground and approach online.
      tracked = { departure: 'TSTA', arrival: 'EGLL' }
    })

    it('stops using the IVAO data already read: no controllers, no status, no traffic, no more requests', async () => {
      service.start()
      await settle()
      expect(published.controllers.at(-1)?.airports[0]?.stations.length).toBeGreaterThan(0)
      expect(statuses().at(-1)).toMatchObject({ state: 'online', callsign: 'TST001', hidesBeyondAtc: true })
      settings = { ...settings, ivaoVid: null }
      service.refresh()
      expect(published.controllers.at(-1)?.airports).toEqual([])
      expect(statuses().at(-1)).toMatchObject({ state: 'unknown', hidesBeyondAtc: false })
      expect(last()).toEqual({ network: 'ivao', state: 'needsVid', aircraft: [] })
      const calls = fetchMock.mock.calls.length
      await clock.advance(10 * 60_000)
      expect(fetchMock.mock.calls.length).toBe(calls)
    })

    it('ignores an IVAO answer still on its way when the VID is cleared, and reads again once it is entered', async () => {
      let release: (response: Response) => void = () => undefined
      fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (release = resolve)))
      service.start()
      settings = { ...settings, ivaoVid: null }
      service.refresh()
      release(okResponse(fixtureText('ivao-synthetic.json')))
      await settle()
      expect(statuses().at(-1) ?? { state: 'unknown' }).toMatchObject({ state: 'unknown' })
      expect(published.controllers.at(-1)?.airports ?? []).toEqual([])
      settings = { ...settings, ivaoVid: '900001' }
      service.refresh()
      await clock.advance(15_000)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(statuses().at(-1)).toMatchObject({ state: 'online', callsign: 'TST001' })
    })
  })

  describe('the ATIS for the weather panel', () => {
    const ask = (
      ...requests: { icao: string; slot: 'departure' | 'destination' | 'alternate' | 'custom' }[]
    ) => service.atisAt(requests)

    beforeEach(() => {
      // Nothing draws traffic and no flight is tracked: only the ATIS asks for the feed.
      switches = { networkOn: false, simOn: false, atcOn: false }
    })

    it('reads the feed once for a request, however nothing else wants it, and answers each tab with its own ATIS', async () => {
      const answer = ask(
        { icao: 'EGLL', slot: 'departure' },
        { icao: 'EGLL', slot: 'destination' },
        { icao: 'EGSS', slot: 'alternate' }
      )
      await settle()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(
        (await answer).airports.map((a) => [a.icao, a.slot, a.state, a.atis.map((x) => x.callsign)])
      ).toEqual([
        ['EGLL', 'departure', 'shown', ['EGLL_D_ATIS']],
        ['EGLL', 'destination', 'shown', ['EGLL_A_ATIS']],
        ['EGSS', 'alternate', 'none', []]
      ])
    })

    it('answers from the feed held while it is under a minute old, with no new read', async () => {
      await ask({ icao: 'EGKK', slot: 'departure' })
      await clock.advance(ATIS_FRESH_MS - 1000)
      const answer = await ask({ icao: 'EGKK', slot: 'destination' })
      expect(answer.airports[0]).toMatchObject({ state: 'shown' })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('reads again once the feed held is older than that, and never sooner than 15 s after the last read', async () => {
      await ask({ icao: 'EGKK', slot: 'departure' })
      await clock.advance(ATIS_FRESH_MS + 1000)
      await ask({ icao: 'EGKK', slot: 'departure' })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('shares one read between requests made together', async () => {
      const first = ask({ icao: 'EGLL', slot: 'departure' })
      const second = ask({ icao: 'EGKK', slot: 'departure' })
      await settle()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect((await first).airports[0]?.atis[0]?.callsign).toBe('EGLL_D_ATIS')
      expect((await second).airports[0]?.atis[0]?.callsign).toBe('EGKK_ATIS')
    })

    it('shows nothing, and reads nothing, with no network chosen', async () => {
      settings = { ...settings, network: null }
      expect(await ask({ icao: 'EGLL', slot: 'departure' })).toEqual({ network: null, airports: [] })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('shows nothing, and reads nothing, for IVAO without a VID (Regulation D.2)', async () => {
      settings = { ...settings, network: 'ivao', ivaoVid: null }
      expect(await ask({ icao: 'EGLL', slot: 'departure' })).toEqual({ network: null, airports: [] })
      await clock.advance(60_000)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('reads IVAO once the VID is entered, and gives each tab the controller that tab would call', async () => {
      settings = { ...settings, network: 'ivao', ivaoVid: '900001' }
      fetchMock.mockImplementation(() => Promise.resolve(okResponse(fixtureText('ivao-synthetic.json'))))
      const answer = await ask({ icao: 'TSTA', slot: 'departure' }, { icao: 'TSTA', slot: 'destination' })
      expect(answer.network).toBe('ivao')
      expect(answer.airports.map((a) => a.atis.map((x) => x.callsign))).toEqual([['TSTA_TWR'], ['TSTA_APP']])
    })

    it('says unavailable when the read fails, and holds to the back-off for the next request', async () => {
      fetchMock.mockImplementation(() => Promise.reject(new Error('network down')))
      const failed = ask({ icao: 'EGLL', slot: 'departure' })
      await settle()
      expect((await failed).airports[0]).toMatchObject({ state: 'unavailable', atis: [] })
      // The next request must wait out the 30 s back-off: it gives up at its own limit, with no new read.
      const waiting = ask({ icao: 'EGLL', slot: 'departure' })
      await clock.advance(ATIS_WAIT_MS + 1000)
      expect((await waiting).airports[0]?.state).toBe('unavailable')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('answers a waiting request when the service stops, as unavailable, and clears its timer', async () => {
      let release: (response: Response) => void = () => undefined
      fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (release = resolve)))
      const waiting = ask({ icao: 'EGLL', slot: 'departure' })
      await settle()
      service.stop()
      release(okResponse(fixtureText('vatsim-busy.json')))
      await settle()
      expect((await waiting).airports[0]?.state).toBe('unavailable')
      expect(clock.pendingCount).toBe(0)
    })

    it('answers nothing after the service has stopped, without waiting', async () => {
      service.stop()
      expect(await ask({ icao: 'EGLL', slot: 'departure' })).toEqual({ network: null, airports: [] })
    })
  })

  describe('the ATC layer', () => {
    const atcLayer = (): NetworkAtc | undefined => published.atc.at(-1)
    const chooseVatsim = (): void => {
      settings = { ...settings, network: 'vatsim' }
    }

    /** A feed with one centre controller and nothing else. */
    function centreFeed(): Response {
      return okResponse(
        JSON.stringify({
          general: { update_timestamp: '2026-10-24T21:05:00Z' },
          pilots: [],
          controllers: [
            { callsign: 'LON_C_CTR', name: 'Test Controller', frequency: '133.700', facility: 6 }
          ],
          atis: []
        })
      )
    }

    beforeEach(() => {
      switches = { networkOn: false, simOn: false, atcOn: true }
      chooseVatsim()
    })

    it('says it is off, and reads nothing, while its switch is off', async () => {
      switches = { networkOn: false, simOn: false, atcOn: false }
      service.start()
      await clock.advance(120_000)
      expect(atcLayer()).toEqual({ network: 'vatsim', state: 'off', areas: [], airports: [] })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(published.layers.at(-1)).toMatchObject({ atcOn: false, drawAtc: false })
    })

    it('says no network is chosen, and reads nothing, even with its switch on', async () => {
      settings = { ...settings, network: null }
      service.start()
      await clock.advance(120_000)
      expect(atcLayer()).toEqual({ network: null, state: 'noNetwork', areas: [], airports: [] })
      expect(published.layers.at(-1)).toMatchObject({ atcOn: true, drawAtc: false })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('reads nothing for IVAO without a VID (Regulation D.2), and says why', async () => {
      settings = { ...settings, network: 'ivao', ivaoVid: null }
      service.start()
      await clock.advance(120_000)
      expect(atcLayer()).toEqual({ network: 'ivao', state: 'needsVid', areas: [], airports: [] })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('reads the feed once a minute while it is the only thing drawing, and publishes the staffed airports of the whole network', async () => {
      service.start()
      await settle()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      await clock.advance(59_000)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      await clock.advance(1_000)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      const layer = atcLayer()
      expect(layer?.state).toBe('shown')
      expect(
        layer?.airports.map((a) => [a.icao, a.stations.map((s) => s.callsign), a.atis.map((x) => x.callsign)])
      ).toEqual([
        ['EGKK', ['EGKK_N_GND', 'EGKK_TWR'], ['EGKK_ATIS']],
        ['EGLL', ['EGLL_2_GND'], ['EGLL_A_ATIS', 'EGLL_D_ATIS']]
      ])
      expect(layer?.areas).toEqual([])
    })

    it('draws a staffed centre as its area, with who is on it', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(centreFeed()))
      service.start()
      await settle()
      const [area] = atcLayer()?.areas ?? []
      expect(area).toMatchObject({ kind: 'centre', id: 'EGTT-C', name: 'London ACC (Central) - London' })
      expect(area?.stations).toEqual([
        // The feed names this controller; the name is never carried.
        { callsign: 'LON_C_CTR', frequency: '133.700', position: 'ctr' }
      ])
    })

    it('publishes only what changed: a read that finds the same controllers publishes nothing', async () => {
      service.start()
      await clock.advance(60_000)
      const count = published.atc.length
      await clock.advance(60_000)
      await clock.advance(60_000)
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3)
      expect(published.atc.length).toBe(count)
    })

    it('publishes the change when a controller logs on', async () => {
      service.start()
      await settle()
      fetchMock.mockImplementation(() => Promise.resolve(centreFeed()))
      await clock.advance(60_000)
      expect(atcLayer()?.areas.map((a) => a.id)).toEqual(['EGTT-C'])
      expect(atcLayer()?.airports).toEqual([])
    })

    it('has a switch of its own: it leaves the two traffic switches as they were, and they leave it', () => {
      switches = { networkOn: true, simOn: false, atcOn: false }
      service.start()
      service.setAtcOn(true)
      expect(switches).toEqual({ networkOn: true, simOn: false, atcOn: true })
      service.setSimOn(true)
      expect(switches).toEqual({ networkOn: false, simOn: true, atcOn: true })
      service.setNetworkOn(true)
      expect(switches).toEqual({ networkOn: true, simOn: false, atcOn: true })
      service.setAtcOn(false)
      expect(switches).toEqual({ networkOn: true, simOn: false, atcOn: false })
    })

    it('shows with the network traffic: the traffic layer’s 15 s read serves both', async () => {
      switches = { networkOn: true, simOn: false, atcOn: true }
      service.start()
      await settle()
      await clock.advance(15_000)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(published.layers.at(-1)).toMatchObject({ drawNetwork: true, drawAtc: true })
      expect(atcLayer()?.airports.length).toBeGreaterThan(0)
      expect(last()?.state).toBe('shown')
    })

    it('stops reading and says it is off when switched off, and starts again when switched on', async () => {
      service.start()
      await settle()
      service.setAtcOn(false)
      expect(atcLayer()).toEqual({ network: 'vatsim', state: 'off', areas: [], airports: [] })
      await clock.advance(120_000)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      service.setAtcOn(true)
      await settle()
      expect(atcLayer()?.state).toBe('shown')
      expect(atcLayer()?.airports.length).toBeGreaterThan(0)
    })

    it('says it is unavailable once the feed has failed for as long as the last answer is kept, with nothing drawn', async () => {
      service.start()
      await settle()
      fetchMock.mockImplementation(() => Promise.reject(new Error('down')))
      await clock.advance(60_000 + STALE_AFTER_MS + 1_000)
      expect(atcLayer()).toEqual({ network: 'vatsim', state: 'unavailable', areas: [], airports: [] })
    })

    it('says it is unavailable when the bundled areas cannot be read, rather than drawing half of it', async () => {
      areaData = null
      service.start()
      await settle()
      expect(atcLayer()).toEqual({ network: 'vatsim', state: 'unavailable', areas: [], airports: [] })
    })

    it('is shown with nothing until the first read lands', () => {
      fetchMock.mockImplementation(() => new Promise<Response>(() => undefined))
      service.start()
      expect(atcLayer()).toEqual({ network: 'vatsim', state: 'shown', areas: [], airports: [] })
    })
  })

  describe('stopping', () => {
    it('stops all timers and ignores a late answer', async () => {
      let release: (response: Response) => void = () => undefined
      fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (release = resolve)))
      service.start()
      await settle()
      service.stop()
      release(okResponse(fixtureText('vatsim-busy.json')))
      await settle()
      expect(published.traffic.at(-1)?.aircraft ?? []).toEqual([])
      expect(clock.pendingCount).toBe(0)
    })

    it('does nothing after stop', async () => {
      service.start()
      await settle()
      service.stop()
      const before = published.traffic.length
      service.refresh()
      await clock.advance(60_000)
      expect(published.traffic.length).toBe(before)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
  })
})
