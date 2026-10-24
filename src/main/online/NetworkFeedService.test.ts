import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { LatLon } from '@shared/geo'
import type { NetworkTraffic, OnlineNetworkSettings, TrafficLayers } from '@shared/ipc'
import {
  FAILURE_LOG_INTERVAL_MS,
  FEED_TIMEOUT_MS,
  NetworkFeedService,
  STALE_AFTER_MS,
  type FeedTimers
} from './NetworkFeedService'
import { REAL_FEED_URLS, type FeedUrls } from './feed-urls'

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
  let published: { traffic: NetworkTraffic[]; layers: TrafficLayers[] }
  let settings: OnlineNetworkSettings
  let switches: { networkOn: boolean; simOn: boolean }
  let centre: LatLon | null
  let fetchMock: ReturnType<typeof vi.fn>
  let warn: Mock<(message: string) => void>
  let urls: FeedUrls
  let service: NetworkFeedService

  function build(): void {
    service = new NetworkFeedService({
      hub: {
        publish: ((topic: string, payload: unknown) => {
          if (topic === 'networkTraffic') published.traffic.push(payload as NetworkTraffic)
          if (topic === 'trafficLayers') published.layers.push(payload as TrafficLayers)
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
      centre: () => centre,
      log: { warn }
    })
  }

  const last = (): NetworkTraffic | undefined => published.traffic.at(-1)

  beforeEach(() => {
    clock = new FakeClock()
    published = { traffic: [], layers: [] }
    settings = { network: 'vatsim', vatsimCid: null, ivaoVid: null }
    switches = { networkOn: true, simOn: false }
    centre = EGLL
    fetchMock = vi.fn(() => Promise.resolve(okResponse(fixtureText('vatsim-busy.json'))))
    warn = vi.fn()
    urls = { vatsimStatus: null, vatsimData: 'http://feed.test/vatsim', ivao: 'http://feed.test/ivao' }
    build()
  })

  describe('publishing', () => {
    it('says the layer is off, without a request, while the switch is off', async () => {
      switches = { networkOn: false, simOn: false }
      service.start()
      await clock.advance(60_000)
      expect(last()).toEqual({ network: 'vatsim', state: 'off', aircraft: [] })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(published.layers.at(-1)).toMatchObject({ networkOn: false, drawNetwork: false })
    })

    it('says no network is chosen, without a request', async () => {
      settings = { network: null, vatsimCid: null, ivaoVid: null }
      service.start()
      await clock.advance(60_000)
      expect(last()).toEqual({ network: null, state: 'noNetwork', aircraft: [] })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('makes no request at all for IVAO without a VID, however long it runs', async () => {
      settings = { network: 'ivao', vatsimCid: null, ivaoVid: null }
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
      settings = { network: 'vatsim', vatsimCid: String(own?.cid), ivaoVid: null }
      clock = new FakeClock()
      build()
      service.start()
      await settle()
      expect(last()?.aircraft.length).toBe(everyone - 1)
      expect(last()?.aircraft.some((a) => a.callsign === own?.callsign)).toBe(false)
    })

    it('says there is no centre when there is no position, and starts once there is one', async () => {
      centre = null
      service.start()
      await settle()
      expect(last()).toEqual({ network: 'vatsim', state: 'noCentre', aircraft: [] })
      expect(fetchMock).not.toHaveBeenCalled()
      centre = EGLL
      service.onPositionChanged()
      await settle()
      expect(last()?.state).toBe('shown')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('ignores a position change when it is not waiting for one', async () => {
      service.start()
      await settle()
      const before = published.traffic.length
      service.onPositionChanged()
      expect(published.traffic.length).toBe(before)
    })

    it('publishes the layers at start, and again when the switch is turned on from any screen', async () => {
      switches = { networkOn: false, simOn: false }
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

    it('holds the sim layer back while the network layer draws', async () => {
      switches = { networkOn: true, simOn: true }
      service.start()
      expect(published.layers.at(-1)).toMatchObject({
        drawNetwork: true,
        drawSim: false,
        simBlockedByNetwork: true
      })
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
      settings = { network: 'ivao', vatsimCid: null, ivaoVid: '900001' }
      fetchMock.mockImplementation(() => Promise.resolve(okResponse(fixtureText('ivao-synthetic.json'))))
      service.start()
      await settle()
      expect(fetchMock.mock.calls[0]?.[0]).toBe('http://feed.test/ivao')
      expect(last()?.state).toBe('shown')
    })

    it('leaves out the pilot’s own VID on IVAO', async () => {
      settings = { network: 'ivao', vatsimCid: null, ivaoVid: '900001' }
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
      settings = { network: 'ivao', vatsimCid: null, ivaoVid: null }
      service.refresh()
      expect(last()).toEqual({ network: 'ivao', state: 'needsVid', aircraft: [] })
      settings = { network: 'ivao', vatsimCid: null, ivaoVid: '900001' }
      fetchMock.mockImplementation(() => Promise.resolve(okResponse(fixtureText('ivao-synthetic.json'))))
      service.refresh()
      expect(last()?.aircraft).toEqual([])
    })

    it('ignores the answer to a request for a network the pilot has since left', async () => {
      let release: (response: Response) => void = () => undefined
      fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (release = resolve)))
      service.start()
      settings = { network: 'ivao', vatsimCid: null, ivaoVid: null }
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
