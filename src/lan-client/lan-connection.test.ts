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

  it('treats a snapshot without a flight as having none', () => {
    expect(parseServerMessage('{"t":"snapshot","topics":{}}')).toMatchObject({ flight: null })
  })

  it('reads an error without a message as an empty one', () => {
    expect(parseServerMessage('{"t":"error"}')).toEqual({ t: 'error', message: '' })
  })
})
