import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LanConnection, parseServerMessage, type LinkSocket, type TokenStore } from './lan-connection'

class FakeSocket implements LinkSocket {
  readyState = 0
  sent: unknown[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  send(text: string): void {
    this.sent.push(JSON.parse(text))
  }
  close(): void {
    this.closed = true
    this.onclose?.()
  }
  open(): void {
    this.readyState = 1
    this.onopen?.()
  }
  say(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
  drop(): void {
    this.onclose?.()
  }
}

function setup(token: string | null = null) {
  let stored = token
  const store: TokenStore = {
    get: () => stored,
    set: (t) => (stored = t),
    clear: () => (stored = null)
  }
  const sockets: FakeSocket[] = []
  const link = new LanConnection(
    'ws://192.168.1.136:8765/live',
    store,
    () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    "Callum's iPad"
  )
  const states: string[] = []
  link.onState((s) => states.push(s))
  return { link, sockets, states, token: () => stored }
}

const FLIGHT = {
  flight: {
    flightId: 7,
    depIcao: 'WSSS',
    arrIcao: 'EGLL',
    flightNumber: 'SIA321',
    schedInUtc: null,
    registration: '9V-SKA',
    icaoType: 'A388',
    ofpJson: null
  },
  trackPoints: []
}

describe('LanConnection', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('waits for a code when the device has no token', () => {
    const { link, sockets, states } = setup()
    link.start()
    expect(states).toEqual(['needs-pairing'])
    expect(sockets).toHaveLength(0)
  })

  it('shows it is connecting while a code is being tried, and goes back to asking when the PC never answers', () => {
    const { link, sockets, states } = setup()
    link.start()
    link.pair('123456')
    expect(states).toEqual(['needs-pairing', 'starting'])
    sockets[0].drop()
    expect(states).toEqual(['needs-pairing', 'starting', 'needs-pairing'])
    vi.advanceTimersByTime(60_000)
    expect(sockets).toHaveLength(1)
  })

  it('pairs with the typed code, keeps the token and goes live on the snapshot', () => {
    const { link, sockets, states, token } = setup()
    link.start()
    link.pair(' 123456 ')
    sockets[0].open()
    expect(sockets[0].sent).toEqual([{ t: 'pair', code: '123456', name: "Callum's iPad" }])
    sockets[0].say({ t: 'paired', token: 'tok' })
    sockets[0].say({ t: 'snapshot', topics: { simTelemetry: { altitudeM: 1000 } }, flight: FLIGHT })
    expect(token()).toBe('tok')
    expect(states).toEqual(['needs-pairing', 'starting', 'connected'])
    expect(link.flight).toEqual(FLIGHT)
    expect(link.latest('simTelemetry')).toEqual({ altitudeM: 1000 })
  })

  it('says the code was wrong when the PC denies a pairing attempt', () => {
    const { link, sockets, states, token } = setup()
    link.start()
    link.pair('000000')
    sockets[0].open()
    sockets[0].say({ t: 'denied' })
    sockets[0].drop()
    expect(states).toEqual(['needs-pairing', 'starting', 'wrong-code'])
    expect(token()).toBeNull()
  })

  it('says hello with the stored token', () => {
    const { link, sockets } = setup('tok')
    link.start()
    sockets[0].open()
    expect(sockets[0].sent).toEqual([{ t: 'hello', token: 'tok' }])
  })

  it('forgets a token the PC no longer knows (revoked) and asks for a code again', () => {
    const { link, sockets, states, token } = setup('tok')
    link.start()
    sockets[0].open()
    sockets[0].say({ t: 'denied' })
    expect(token()).toBeNull()
    expect(states.at(-1)).toBe('needs-pairing')
  })

  it('passes each topic to its subscribers, and the snapshot topics too', () => {
    const { link, sockets } = setup('tok')
    const seen: unknown[] = []
    const stop = link.subscribe('simTelemetry', (t) => seen.push(t))
    link.start()
    sockets[0].open()
    sockets[0].say({ t: 'snapshot', topics: { simTelemetry: { n: 1 } }, flight: null })
    sockets[0].say({ t: 'topic', name: 'simTelemetry', payload: { n: 2 } })
    stop()
    sockets[0].say({ t: 'topic', name: 'simTelemetry', payload: { n: 3 } })
    expect(seen).toEqual([{ n: 1 }, { n: 2 }])
    expect(link.latest('simTelemetry')).toEqual({ n: 3 })
  })

  it('tells flight listeners when a snapshot arrives, and forgets old topics on a new one', () => {
    const { link, sockets } = setup('tok')
    const flights: unknown[] = []
    link.onFlight((f) => flights.push(f))
    link.start()
    sockets[0].open()
    sockets[0].say({ t: 'snapshot', topics: { simTelemetry: { n: 1 } }, flight: FLIGHT })
    sockets[0].say({ t: 'snapshot', topics: {}, flight: null })
    expect(flights).toEqual([FLIGHT, null])
    expect(link.latest('simTelemetry')).toBeUndefined()
  })

  it('swaps in a flight the PC starts tracking after the device connected, with its track', () => {
    const { link, sockets } = setup('tok')
    const flights: unknown[] = []
    link.onFlight((f) => flights.push(f))
    link.start()
    sockets[0].open()
    sockets[0].say({ t: 'snapshot', topics: {}, flight: null })
    sockets[0].say({ t: 'flight', flight: { ...FLIGHT, trackPoints: [{ id: 1 }] } })
    expect(link.flight?.flight.flightId).toBe(7)
    expect(link.track).toEqual([{ id: 1 }])
    sockets[0].say({ t: 'topic', name: 'trackingPoint', payload: { id: 2 } })
    sockets[0].say({ t: 'topic', name: 'trackingPoint', payload: { id: 2 } })
    sockets[0].say({
      t: 'topic',
      name: 'trackingPointsUpdated',
      payload: [{ id: 2, excludedReason: 'jump' }, { id: 9 }]
    })
    // A cleanup pass sends only the points it changed: they are patched in place and the rest of the trail stays.
    expect(link.track).toEqual([{ id: 1 }, { id: 2, excludedReason: 'jump' }])
    sockets[0].say({ t: 'topic', name: 'trackingPointsUpdated', payload: [] })
    expect(link.track).toHaveLength(2)
    sockets[0].say({ t: 'flight', flight: null })
    expect(link.flight).toBeNull()
    expect(link.track).toEqual([])
    expect(flights).toHaveLength(3)
  })

  describe('lookups', () => {
    function liveLink() {
      const ctx = setup('tok')
      ctx.link.start()
      ctx.sockets[0].open()
      ctx.sockets[0].say({ t: 'snapshot', topics: {}, flight: null })
      return ctx
    }

    it('asks the PC and resolves with its answer, matching by id', async () => {
      const { link, sockets } = liveLink()
      const first = link.query('taxi.get', 'WSSS')
      const second = link.query('airfields')
      expect(sockets[0].sent.slice(1)).toEqual([
        { t: 'query', id: 1, name: 'taxi.get', args: ['WSSS'] },
        { t: 'query', id: 2, name: 'airfields', args: [] }
      ])
      sockets[0].say({ t: 'result', id: 2, data: ['EGLL'] })
      sockets[0].say({ t: 'result', id: 1, data: [{ a: 1 }] })
      await expect(first).resolves.toEqual([{ a: 1 }])
      await expect(second).resolves.toEqual(['EGLL'])
    })

    it('sends several arguments in order', () => {
      const { link, sockets } = liveLink()
      void link.query('navdata.listSids', 'WSSS', null)
      expect(sockets[0].sent.at(-1)).toEqual({
        t: 'query',
        id: 1,
        name: 'navdata.listSids',
        args: ['WSSS', null]
      })
    })

    it('sends a command to the PC, and throws while not connected', () => {
      const { link, sockets } = liveLink()
      link.command('track.setProcedureSelection', { sidIdent: 'KAMI2A' })
      expect(sockets[0].sent.at(-1)).toEqual({
        t: 'cmd',
        name: 'track.setProcedureSelection',
        args: [{ sidIdent: 'KAMI2A' }]
      })
      const idle = setup('tok')
      expect(() => idle.link.command('gsx.toggleMenu')).toThrow('Not connected')
    })

    const sentQueries = (sockets: FakeSocket[], n = 0) =>
      sockets[n].sent.filter((m) => (m as { t: string }).t === 'query') as {
        id: number
        name: string
        args: unknown[]
      }[]

    /** Moves time on in steps, with the PC's heartbeat arriving as it does, so a long wait is not taken for a dead link. */
    const wait = (sockets: FakeSocket[], ms: number): void => {
      for (let left = ms; left > 0; left -= 5000) {
        vi.advanceTimersByTime(Math.min(5000, left))
        sockets.at(-1)?.say({ t: 'hb' })
      }
    }

    it('ignores an answer nobody asked for, and rejects while not connected', async () => {
      const idle = setup('tok')
      await expect(idle.link.query('airfields')).rejects.toThrow('Not connected')
      const { link, sockets } = liveLink()
      sockets[0].say({ t: 'result', id: 99, data: 1 })
      const asked = link.query('echo', 1)
      sockets[0].say({ t: 'result', id: 1, data: 'fine' })
      await expect(asked).resolves.toBe('fine')
    })

    describe('retrying', () => {
      beforeEach(() => void vi.spyOn(Math, 'random').mockReturnValue(1))
      afterEach(() => void vi.restoreAllMocks())

      it('asks again after a wait that doubles when the PC could not answer, and gives up after four tries', async () => {
        const { link, sockets } = liveLink()
        const asked = link.query('stands', 'WSSS')
        const outcome = asked.then(
          () => 'answered',
          (e: Error) => e.message
        )
        expect(sentQueries(sockets)).toHaveLength(1)
        sockets[0].say({ t: 'result', id: 1, error: true })
        vi.advanceTimersByTime(999)
        expect(sentQueries(sockets)).toHaveLength(1)
        vi.advanceTimersByTime(1)
        expect(sentQueries(sockets)).toHaveLength(2)
        sockets[0].say({ t: 'result', id: 2, error: true })
        vi.advanceTimersByTime(1999)
        expect(sentQueries(sockets)).toHaveLength(2)
        vi.advanceTimersByTime(1)
        expect(sentQueries(sockets)).toHaveLength(3)
        sockets[0].say({ t: 'result', id: 3, error: true })
        vi.advanceTimersByTime(4000)
        expect(sentQueries(sockets)).toHaveLength(4)
        sockets[0].say({ t: 'result', id: 4, error: true })
        expect(await outcome).toBe('The PC could not answer')
        vi.advanceTimersByTime(60_000)
        expect(sentQueries(sockets)).toHaveLength(4)
      })

      it('succeeds on a retry, and the caller never knows', async () => {
        const { link, sockets } = liveLink()
        const asked = link.query('navdata.listSids', 'WSSS', null)
        sockets[0].say({ t: 'result', id: 1, error: true })
        vi.advanceTimersByTime(1000)
        sockets[0].say({ t: 'result', id: 2, data: [{ identifier: 'KAMI2A' }] })
        await expect(asked).resolves.toEqual([{ identifier: 'KAMI2A' }])
      })

      it('waits as long as the PC says when it answers busy', () => {
        const { link, sockets } = liveLink()
        void link.query('echo', 1).catch(() => undefined)
        sockets[0].say({ t: 'result', id: 1, error: true, busy: true, retryAfterMs: 250 })
        vi.advanceTimersByTime(249)
        expect(sentQueries(sockets)).toHaveLength(1)
        vi.advanceTimersByTime(1)
        expect(sentQueries(sockets)).toHaveLength(2)
      })

      it('asks again when the PC does not answer a quick lookup in ten seconds, and gives up on the fourth', async () => {
        const { link, sockets } = liveLink()
        const outcome = link.query('airfields').then(
          () => 'answered',
          (e: Error) => e.message
        )
        vi.advanceTimersByTime(9999)
        expect(sentQueries(sockets)).toHaveLength(1)
        vi.advanceTimersByTime(1)
        vi.advanceTimersByTime(1000)
        expect(sentQueries(sockets)).toHaveLength(2)
        wait(sockets, 10_000 + 2000)
        wait(sockets, 10_000 + 4000)
        expect(sentQueries(sockets)).toHaveLength(4)
        wait(sockets, 10_000)
        expect(await outcome).toBe('The PC did not answer')
      })

      it('gives a slow lookup three minutes', () => {
        const { link, sockets } = liveLink()
        void link.query('taxi.refresh', 'EGLL').catch(() => undefined)
        wait(sockets, 179_999)
        expect(sentQueries(sockets)).toHaveLength(1)
        vi.advanceTimersByTime(1 + 1000)
        expect(sentQueries(sockets)).toHaveLength(2)
      })
    })

    it('never has more than four quick lookups out at once, and sends the rest as answers come in', async () => {
      const { link, sockets } = liveLink()
      const asked = Array.from({ length: 7 }, (_, i) => link.query('echo', i))
      expect(sentQueries(sockets)).toHaveLength(4)
      sockets[0].say({ t: 'result', id: 1, data: 'a' })
      expect(sentQueries(sockets)).toHaveLength(5)
      sockets[0].say({ t: 'result', id: 2, data: 'b' })
      sockets[0].say({ t: 'result', id: 3, data: 'c' })
      expect(sentQueries(sockets)).toHaveLength(7)
      for (const id of [4, 5, 6, 7]) sockets[0].say({ t: 'result', id, data: id })
      await expect(asked[0]).resolves.toBe('a')
      await expect(asked[6]).resolves.toBe(7)
      expect(sentQueries(sockets).map((m) => m.args[0])).toEqual([0, 1, 2, 3, 4, 5, 6])
    })

    it('keeps slow lookups in their own two slots, so they never hold up a quick one', () => {
      const { link, sockets } = liveLink()
      for (const icao of ['EGLL', 'WSSS', 'VHHH'])
        void link.query('navdata.refreshAirport', icao).catch(() => undefined)
      expect(sentQueries(sockets).map((m) => m.args[0])).toEqual(['EGLL', 'WSSS'])
      void link.query('echo', 'quick').catch(() => undefined)
      expect(sentQueries(sockets).at(-1)).toMatchObject({ name: 'echo' })
      // A slow one answered frees a slow slot.
      sockets[0].say({ t: 'result', id: 1, data: null })
      expect(sentQueries(sockets).map((m) => m.args[0])).toEqual(['EGLL', 'WSSS', 'quick', 'VHHH'])
    })

    describe('when the link drops', () => {
      it('keeps the lookups, without using up a try, and sends them when the link is back', async () => {
        const { link, sockets } = liveLink()
        const asked = link.query('navdata.listSids', 'WSSS', null)
        const later = link.query('echo', 'x')
        expect(sentQueries(sockets)).toHaveLength(2)
        sockets[0].drop()
        vi.advanceTimersByTime(1000)
        // The page reconnects, and the PC sends its snapshot.
        sockets[1].open()
        sockets[1].say({ t: 'snapshot', topics: {}, flight: null })
        expect(sentQueries(sockets, 1).map((m) => m.name)).toEqual(['navdata.listSids', 'echo'])
        sockets[1].say({ t: 'result', id: sentQueries(sockets, 1)[0].id, data: ['KAMI2A'] })
        sockets[1].say({ t: 'result', id: sentQueries(sockets, 1)[1].id, data: 'y' })
        await expect(asked).resolves.toEqual(['KAMI2A'])
        await expect(later).resolves.toBe('y')
      })

      it('fails them if the link stays down for as long as the page waits to call it dead', async () => {
        const { link, sockets } = liveLink()
        const asked = link.query('echo', 1)
        const failure = expect(asked).rejects.toThrow('Not connected')
        sockets[0].drop()
        vi.advanceTimersByTime(60_000)
        await failure
      })

      it('fails them at once when the page is stopped', async () => {
        const { link } = liveLink()
        const asked = link.query('echo', 1)
        const failure = expect(asked).rejects.toThrow('Not connected')
        link.stop()
        await failure
      })
    })

    describe('telling the PC what it gave up on', () => {
      beforeEach(() => void vi.spyOn(Math, 'random').mockReturnValue(1))
      afterEach(() => void vi.restoreAllMocks())

      const reports = (sockets: FakeSocket[]) =>
        sockets[0].sent.filter((m) => (m as { t: string }).t === 'report')

      it('sends a report with a fixed code when a lookup is given up on after its last try', async () => {
        const { link, sockets } = liveLink()
        const outcome = link.query('navdata.listSids', 'ZUCK', null).catch((e: Error) => e.message)
        for (let id = 1; id <= 4; id++) {
          sockets[0].say({ t: 'result', id, error: true })
          wait(sockets, 4000)
        }
        expect(await outcome).toBe('The PC could not answer')
        expect(reports(sockets)).toEqual([{ t: 'report', code: 'query-failed:navdata.listSids' }])
      })

      it('says nothing about a lookup that is not in the PC’s table, whose name the PC would refuse', async () => {
        const { link, sockets } = liveLink()
        const outcome = link.query('made.up').catch((e: Error) => e.message)
        for (let id = 1; id <= 4; id++) {
          sockets[0].say({ t: 'result', id, error: true })
          wait(sockets, 4000)
        }
        await outcome
        expect(reports(sockets)).toEqual([])
      })

      it('sends a report only while connected', () => {
        const { link, sockets } = liveLink()
        link.report('route-missing')
        expect(reports(sockets)).toEqual([{ t: 'report', code: 'route-missing' }])
        sockets[0].drop()
        link.report('route-missing')
        expect(reports(sockets)).toHaveLength(1)
        expect(() => setup('tok').link.report('route-missing')).not.toThrow()
      })

      it('sends the detail with a report when it has one, and leaves the field out when it has not', () => {
        const { link, sockets } = liveLink()
        link.report('script-error', 'Uncaught Error: boom')
        link.report('route-applied', 'r3')
        link.report('reconnected')
        expect(reports(sockets)).toEqual([
          { t: 'report', code: 'script-error', detail: 'Uncaught Error: boom' },
          { t: 'report', code: 'route-applied', detail: 'r3' },
          { t: 'report', code: 'reconnected' }
        ])
      })

      it('says it reconnected when the link comes back, not when it first connects', () => {
        const { sockets } = liveLink()
        expect(reports(sockets)).toEqual([])
        sockets[0].drop()
        vi.advanceTimersByTime(1000)
        sockets[1].open()
        sockets[1].say({ t: 'snapshot', topics: {}, flight: null })
        const second = sockets[1].sent.filter((m) => (m as { t: string }).t === 'report')
        expect(second).toEqual([{ t: 'report', code: 'reconnected' }])
        sockets[1].drop()
        vi.advanceTimersByTime(2000)
        sockets[2].open()
        sockets[2].say({ t: 'snapshot', topics: {}, flight: null })
        expect(sockets[2].sent.filter((m) => (m as { t: string }).t === 'report')).toEqual([
          { t: 'report', code: 'reconnected' }
        ])
      })
    })

    describe('sharing and keeping answers', () => {
      it('sends one request for the same lookup asked twice, and answers both', async () => {
        const { link, sockets } = liveLink()
        const first = link.query('navdata.procedureWaypoints', 'ZUCK', 'sid', 'VILU1Z', '03L', null)
        const second = link.query('navdata.procedureWaypoints', 'ZUCK', 'sid', 'VILU1Z', '03L', null)
        expect(sentQueries(sockets)).toHaveLength(1)
        sockets[0].say({ t: 'result', id: 1, data: [{ fixIdent: 'CK403' }] })
        await expect(first).resolves.toEqual([{ fixIdent: 'CK403' }])
        await expect(second).resolves.toEqual([{ fixIdent: 'CK403' }])
      })

      it('answers a lookup it has kept without asking the PC again', async () => {
        const { link, sockets } = liveLink()
        const first = link.query('navdata.listSids', 'ZUCK', '03L')
        sockets[0].say({ t: 'result', id: 1, data: [{ identifier: 'VILU1Z' }] })
        await first
        await expect(link.query('navdata.listSids', 'ZUCK', '03L')).resolves.toEqual([
          { identifier: 'VILU1Z' }
        ])
        expect(sentQueries(sockets)).toHaveLength(1)
        // A different question is a different lookup.
        void link.query('navdata.listSids', 'ZUCK', '21R').catch(() => undefined)
        expect(sentQueries(sockets)).toHaveLength(2)
      })

      it('does not keep an empty answer, which usually means the PC has not loaded that airport yet', async () => {
        const { link, sockets } = liveLink()
        const first = link.query('navdata.listSids', 'ZUCK', null)
        sockets[0].say({ t: 'result', id: 1, data: [] })
        await first
        void link.query('navdata.listSids', 'ZUCK', null).catch(() => undefined)
        expect(sentQueries(sockets)).toHaveLength(2)
      })

      it('does not keep a failure, and does not keep what is not a read of cached data', async () => {
        const { link, sockets } = liveLink()
        const settings = link.query('settings.display')
        sockets[0].say({ t: 'result', id: 1, data: { weightUnit: 'kg' } })
        await settings
        void link.query('settings.display').catch(() => undefined)
        expect(sentQueries(sockets)).toHaveLength(2)
      })

      it('forgets what it kept about an airport when the PC has refreshed it, and only that airport', async () => {
        const { link, sockets } = liveLink()
        const ask = async (icao: string, id: number) => {
          const asked = link.query('navdata.listRunways', icao)
          sockets[0].say({ t: 'result', id, data: [{ ident: '03L' }] })
          await asked
        }
        await ask('ZUCK', 1)
        await ask('VHHH', 2)
        const refresh = link.query('navdata.refreshAirport', 'ZUCK')
        sockets[0].say({ t: 'result', id: 3, data: null })
        await refresh
        await expect(link.query('navdata.listRunways', 'VHHH')).resolves.toEqual([{ ident: '03L' }])
        expect(sentQueries(sockets)).toHaveLength(3)
        void link.query('navdata.listRunways', 'ZUCK').catch(() => undefined)
        expect(sentQueries(sockets)).toHaveLength(4)
      })

      it('forgets everything it kept when the link comes back, since the PC may have refreshed its data meanwhile', async () => {
        const { link, sockets } = liveLink()
        const first = link.query('airfields')
        sockets[0].say({ t: 'result', id: 1, data: [{ icao: 'EGLL' }] })
        await first
        sockets[0].drop()
        vi.advanceTimersByTime(1000)
        sockets[1].open()
        sockets[1].say({ t: 'snapshot', topics: {}, flight: null })
        void link.query('airfields').catch(() => undefined)
        expect(sentQueries(sockets, 1)).toHaveLength(1)
      })
    })
  })

  it('reconnects with a growing wait after the link drops, and resets the wait once live', () => {
    const { link, sockets, states } = setup('tok')
    link.start()
    sockets[0].open()
    sockets[0].say({ t: 'snapshot', topics: {}, flight: null })
    sockets[0].drop()
    expect(states.at(-1)).toBe('offline')
    vi.advanceTimersByTime(999)
    expect(sockets).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(sockets).toHaveLength(2)
    sockets[1].drop()
    vi.advanceTimersByTime(1999)
    expect(sockets).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(sockets).toHaveLength(3)
    sockets[2].open()
    sockets[2].say({ t: 'snapshot', topics: {}, flight: null })
    expect(states.at(-1)).toBe('connected')
    sockets[2].drop()
    vi.advanceTimersByTime(1000)
    expect(sockets).toHaveLength(4)
  })

  describe('a PC that goes quiet', () => {
    it('says so and reconnects when nothing has been heard for 35 s, and not while heartbeats arrive', () => {
      const { link, sockets, states } = setup('tok')
      link.start()
      sockets[0].open()
      sockets[0].say({ t: 'snapshot', topics: {}, flight: null })
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(10_000)
        sockets[0].say({ t: 'hb' })
      }
      expect(states).toEqual(['connected'])
      expect(sockets).toHaveLength(1)
      vi.advanceTimersByTime(40_000)
      expect(states).toEqual(['connected', 'offline'])
      expect(sockets).toHaveLength(2)
      expect(sockets[0].closed).toBe(true)
    })

    it('stops watching once stopped', () => {
      const { link, sockets } = setup('tok')
      link.start()
      sockets[0].open()
      sockets[0].say({ t: 'snapshot', topics: {}, flight: null })
      link.stop()
      vi.advanceTimersByTime(120_000)
      expect(sockets).toHaveLength(1)
    })
  })

  describe('resume (a phone coming back from a lock)', () => {
    it('replaces a socket that looks open but is dead, and is live again on the new snapshot', () => {
      const { link, sockets, states } = setup('tok')
      link.start()
      sockets[0].open()
      sockets[0].say({ t: 'snapshot', topics: {}, flight: null })
      link.resume()
      expect(sockets).toHaveLength(2)
      expect(sockets[0].closed).toBe(true)
      expect(states).toEqual(['connected'])
      sockets[1].open()
      expect(sockets[1].sent).toEqual([{ t: 'hello', token: 'tok' }])
      sockets[1].say({ t: 'snapshot', topics: {}, flight: null })
      expect(link.state).toBe('connected')
    })

    it('reconnects at once, without waiting out the backoff', () => {
      const { link, sockets } = setup('tok')
      link.start()
      sockets[0].drop()
      sockets[1]?.drop()
      vi.advanceTimersByTime(500)
      link.resume()
      expect(sockets.length).toBeGreaterThanOrEqual(2)
      const count = sockets.length
      vi.advanceTimersByTime(60_000)
      expect(sockets.length).toBe(count)
    })

    it('does nothing when there is no token, a code is being tried, or it was stopped', () => {
      const unpaired = setup()
      unpaired.link.start()
      unpaired.link.resume()
      expect(unpaired.sockets).toHaveLength(0)
      unpaired.link.pair('123456')
      unpaired.link.resume()
      expect(unpaired.sockets).toHaveLength(1)
      const stopped = setup('tok')
      stopped.link.start()
      stopped.link.stop()
      stopped.link.resume()
      expect(stopped.sockets).toHaveLength(1)
    })
  })

  it('never waits longer than ten seconds between attempts', () => {
    const { link, sockets } = setup('tok')
    link.start()
    for (let i = 0; i < 8; i++) {
      sockets[i].drop()
      vi.advanceTimersByTime(10_000)
    }
    const before = sockets.length
    sockets[before - 1].drop()
    vi.advanceTimersByTime(10_000)
    expect(sockets).toHaveLength(before + 1)
  })

  it('stops reconnecting once stopped', () => {
    const { link, sockets } = setup('tok')
    link.start()
    sockets[0].open()
    sockets[0].say({ t: 'snapshot', topics: {}, flight: null })
    link.stop()
    vi.advanceTimersByTime(60_000)
    expect(sockets).toHaveLength(1)
    expect(sockets[0].closed).toBe(true)
  })

  it('ignores garbage from the PC', () => {
    const { link, sockets, states } = setup('tok')
    link.start()
    sockets[0].open()
    for (const text of [
      'nope',
      '5',
      'null',
      '{"t":"unknown"}',
      '{"t":"paired"}',
      '{"t":"snapshot"}',
      '{"t":"topic"}'
    ])
      sockets[0].onmessage?.({ data: text })
    sockets[0].onmessage?.({ data: new ArrayBuffer(2) })
    sockets[0].say({ t: 'error', message: 'Not allowed' })
    expect(states).toEqual([])
    expect(link.state).toBe('starting')
  })
})

describe('parseServerMessage', () => {
  it('reads the five kinds the PC sends', () => {
    expect(parseServerMessage('{"t":"paired","token":"x"}')).toEqual({ t: 'paired', token: 'x' })
    expect(parseServerMessage('{"t":"denied"}')).toEqual({ t: 'denied' })
    expect(parseServerMessage('{"t":"error","message":"Not allowed"}')).toEqual({
      t: 'error',
      message: 'Not allowed'
    })
    expect(parseServerMessage('{"t":"snapshot","topics":{},"flight":null}')).toEqual({
      t: 'snapshot',
      topics: {},
      flight: null
    })
    expect(parseServerMessage('{"t":"topic","name":"simTelemetry","payload":1}')).toEqual({
      t: 'topic',
      name: 'simTelemetry',
      payload: 1
    })
  })

  it('reads a lookup result, and ignores one without an id', () => {
    expect(parseServerMessage('{"t":"result","id":3,"data":[1]}')).toEqual({ t: 'result', id: 3, data: [1] })
    expect(parseServerMessage('{"t":"result","id":3,"error":true}')).toEqual({
      t: 'result',
      id: 3,
      data: undefined,
      error: true
    })
    expect(parseServerMessage('{"t":"result"}')).toBeNull()
  })

  it('reads a heartbeat', () => {
    expect(parseServerMessage('{"t":"hb"}')).toEqual({ t: 'hb' })
  })

  it('reads a flight message, with none meaning no flight', () => {
    expect(parseServerMessage('{"t":"flight"}')).toEqual({ t: 'flight', flight: null })
  })

  it('treats a snapshot without a flight as having none', () => {
    expect(parseServerMessage('{"t":"snapshot","topics":{}}')).toMatchObject({ flight: null })
  })

  it('reads an error without a message as an empty one', () => {
    expect(parseServerMessage('{"t":"error"}')).toEqual({ t: 'error', message: '' })
  })
})
