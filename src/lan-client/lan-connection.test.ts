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
  flight: { flightId: 7, depIcao: 'WSSS', arrIcao: 'EGLL', ofpJson: null },
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

  it('pairs with the typed code, keeps the token and goes live on the snapshot', () => {
    const { link, sockets, states, token } = setup()
    link.start()
    link.pair(' 123456 ')
    sockets[0].open()
    expect(sockets[0].sent).toEqual([{ t: 'pair', code: '123456', name: "Callum's iPad" }])
    sockets[0].say({ t: 'paired', token: 'tok' })
    sockets[0].say({ t: 'snapshot', topics: { simTelemetry: { altitudeM: 1000 } }, flight: FLIGHT })
    expect(token()).toBe('tok')
    expect(states).toEqual(['needs-pairing', 'connected'])
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
    expect(states).toEqual(['needs-pairing', 'wrong-code'])
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
        { t: 'query', id: 1, name: 'taxi.get', arg: 'WSSS' },
        { t: 'query', id: 2, name: 'airfields' }
      ])
      sockets[0].say({ t: 'result', id: 2, data: ['EGLL'] })
      sockets[0].say({ t: 'result', id: 1, data: [{ a: 1 }] })
      await expect(first).resolves.toEqual([{ a: 1 }])
      await expect(second).resolves.toEqual(['EGLL'])
    })

    it('rejects when the PC could not answer, and ignores an answer nobody asked for', async () => {
      const { link, sockets } = liveLink()
      const asked = link.query('stands', 'WSSS')
      sockets[0].say({ t: 'result', id: 99, data: 1 })
      sockets[0].say({ t: 'result', id: 1, error: true })
      await expect(asked).rejects.toThrow('could not answer')
    })

    it('rejects while not connected, and when the link drops with a lookup waiting', async () => {
      const idle = setup('tok')
      await expect(idle.link.query('airfields')).rejects.toThrow('Not connected')
      const { link, sockets } = liveLink()
      const waiting = link.query('airfields')
      sockets[0].drop()
      await expect(waiting).rejects.toThrow('Not connected')
    })

    it('gives up after a minute without an answer', async () => {
      const { link } = liveLink()
      const waiting = link.query('airfields')
      const assertion = expect(waiting).rejects.toThrow('did not answer')
      vi.advanceTimersByTime(60_000)
      await assertion
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
