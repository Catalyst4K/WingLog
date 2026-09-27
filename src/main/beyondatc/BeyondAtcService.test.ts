import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BEYONDATC_PORT, BeyondAtcService, EMPTY_STATE, type WebSocketCtor } from './BeyondAtcService'

/** A minimal WHATWG-WebSocket-shaped double, driven manually from tests — same reasoning as
 *  GsxRemoteService.test.ts's FakeWebSocket, but `simulateLine` sends plain text instead of
 *  a JSON envelope, matching BeyondATC's own `Key: value` wire protocol. */
class FakeWebSocket extends EventEmitter {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readonly OPEN = 1
  readyState = FakeWebSocket.CONNECTING
  sent: string[] = []
  closed = false

  constructor(public readonly url: string) {
    super()
  }

  addEventListener(event: string, listener: (...args: unknown[]) => void): void {
    this.on(event, listener)
  }
  removeEventListener(event: string, listener: (...args: unknown[]) => void): void {
    this.off(event, listener)
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close', {})
  }

  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN
    this.emit('open', {})
  }
  /** Simulates one WebSocket text frame — can carry several `\n`-joined lines, matching how
   *  BeyondATC's own snapshot push arrives as several lines in short order. */
  simulateLine(text: string): void {
    this.emit('message', { data: text })
  }
}

function makeCtor(): { ctor: WebSocketCtor; instances: FakeWebSocket[] } {
  const instances: FakeWebSocket[] = []
  class TrackedFakeWebSocket extends FakeWebSocket {
    constructor(url: string) {
      super(url)
      instances.push(this)
    }
  }
  return { ctor: TrackedFakeWebSocket as unknown as WebSocketCtor, instances }
}

describe('BeyondAtcService', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('connects to ws://<host>:<port>/ using the fixed BeyondATC port', () => {
    const { ctor, instances } = makeCtor()
    const service = new BeyondAtcService('localhost', BEYONDATC_PORT, ctor)
    service.start()

    expect(instances[0].url).toBe(`ws://localhost:${BEYONDATC_PORT}/`)
    instances[0].simulateOpen()

    expect(service.getStatus()).toEqual({ state: 'connected', lastError: null })
    service.stop()
  })

  it('defaults to an empty state and transcript before anything arrives', () => {
    const { ctor } = makeCtor()
    const service = new BeyondAtcService('localhost', BEYONDATC_PORT, ctor)

    expect(service.getState()).toEqual(EMPTY_STATE)
    expect(service.getTranscript()).toEqual([])
  })

  it('parses Facility: <name>|<frequency>', () => {
    const { ctor, instances } = makeCtor()
    const service = new BeyondAtcService('localhost', BEYONDATC_PORT, ctor)
    service.start()
    instances[0].simulateOpen()

    instances[0].simulateLine('Facility: Brisbane Delivery|118.850')

    expect(service.getState().facility).toEqual({ name: 'Brisbane Delivery', frequency: '118.850' })
    service.stop()
  })

  it('parses Com2/Callsign/CommsState/Progress JSON values', () => {
    const { ctor, instances } = makeCtor()
    const service = new BeyondAtcService('localhost', BEYONDATC_PORT, ctor)
    service.start()
    instances[0].simulateOpen()

    instances[0].simulateLine('Com2: {"label": "Brisbane Ground", "frequency": "121.700", "monitor": false}')
    instances[0].simulateLine('Callsign: {"full": "Cathay 116 Heavy", "shortForm": "CPA116"}')
    instances[0].simulateLine('CommsState: {"mode": "awaiting", "text": "Awaiting Response"}')
    instances[0].simulateLine('Progress: {"from": "YBBN", "to": "YSSY", "pct": 12}')

    expect(service.getState()).toEqual({
      facility: null,
      com2: { label: 'Brisbane Ground', frequency: '121.700', monitor: false },
      callsign: { full: 'Cathay 116 Heavy', shortForm: 'CPA116' },
      commsState: { mode: 'awaiting', text: 'Awaiting Response' },
      progress: { from: 'YBBN', to: 'YSSY', pct: 12 },
      actions: []
    })
    service.stop()
  })

  it('parses the real Actions capture (bracket/¬-separated, not JSON)', () => {
    const { ctor, instances } = makeCtor()
    const service = new BeyondAtcService('localhost', BEYONDATC_PORT, ctor)
    service.start()
    instances[0].simulateOpen()

    instances[0].simulateLine('Actions: [Request IFR Clearance¬Request Departure Runway Change¬Radio Check¬]')

    expect(service.getState().actions).toEqual([
      'Request IFR Clearance',
      'Request Departure Runway Change',
      'Radio Check'
    ])
    service.stop()
  })

  it('parses an empty Actions list as []', () => {
    const { ctor, instances } = makeCtor()
    const service = new BeyondAtcService('localhost', BEYONDATC_PORT, ctor)
    service.start()
    instances[0].simulateOpen()

    instances[0].simulateLine('Actions: []')

    expect(service.getState().actions).toEqual([])
    service.stop()
  })

  it('ignores a malformed Facility line rather than half-populating it', () => {
    const { ctor, instances } = makeCtor()
    const service = new BeyondAtcService('localhost', BEYONDATC_PORT, ctor)
    service.start()
    instances[0].simulateOpen()

    instances[0].simulateLine('Facility: no separator here')

    expect(service.getState().facility).toBeNull()
    service.stop()
  })

  it('ignores a malformed JSON value line rather than throwing', () => {
    const { ctor, instances } = makeCtor()
    const service = new BeyondAtcService('localhost', BEYONDATC_PORT, ctor)
    service.start()
    instances[0].simulateOpen()

    expect(() => instances[0].simulateLine('CommsState: not json at all')).not.toThrow()
    expect(service.getState().commsState).toBeNull()
    service.stop()
  })

  it('ignores unrecognised keys, out of this plan\'s scope', () => {
    const { ctor, instances } = makeCtor()
    const service = new BeyondAtcService('localhost', BEYONDATC_PORT, ctor)
    service.start()
    instances[0].simulateOpen()

    expect(() => instances[0].simulateLine('DATIS: YBBN|D|Brisbane information Delta.')).not.toThrow()
    expect(() => instances[0].simulateLine('DATIS_END:')).not.toThrow()
    expect(service.getState()).toEqual(EMPTY_STATE)
    service.stop()
  })

  it('accumulates Player/ATC/Traffic/ATCTraffic lines into a tagged transcript', () => {
    const { ctor, instances } = makeCtor()
    const service = new BeyondAtcService('localhost', BEYONDATC_PORT, ctor)
    service.start()
    instances[0].simulateOpen()

    instances[0].simulateLine('Player: Cathay 116 Heavy, radio check.')
    instances[0].simulateLine('ATC: Cathay 116 Heavy, readability 5.')
    instances[0].simulateLine('Traffic: Qantas 7, ready for pushback.')
    instances[0].simulateLine('ATCTraffic: Qantas 7, pushback approved.')

    expect(service.getTranscript().map((e) => ({ speaker: e.speaker, text: e.text }))).toEqual([
      { speaker: 'player', text: 'Cathay 116 Heavy, radio check.' },
      { speaker: 'atc', text: 'Cathay 116 Heavy, readability 5.' },
      { speaker: 'traffic', text: 'Qantas 7, ready for pushback.' },
      { speaker: 'atcTraffic', text: 'Qantas 7, pushback approved.' }
    ])
    service.stop()
  })

  it('splits one message carrying several newline-joined lines', () => {
    const { ctor, instances } = makeCtor()
    const service = new BeyondAtcService('localhost', BEYONDATC_PORT, ctor)
    service.start()
    instances[0].simulateOpen()

    instances[0].simulateLine('Facility: Brisbane Delivery|118.850\r\nCallsign: {"full": "Cathay 116 Heavy", "shortForm": "CPA116"}\r\n')

    expect(service.getState().facility).toEqual({ name: 'Brisbane Delivery', frequency: '118.850' })
    expect(service.getState().callsign).toEqual({ full: 'Cathay 116 Heavy', shortForm: 'CPA116' })
    service.stop()
  })

  it('caps the transcript at 100 entries, dropping the oldest', () => {
    const { ctor, instances } = makeCtor()
    const service = new BeyondAtcService('localhost', BEYONDATC_PORT, ctor)
    service.start()
    instances[0].simulateOpen()

    for (let i = 0; i < 105; i++) instances[0].simulateLine(`Player: line ${i}`)

    const transcript = service.getTranscript()
    expect(transcript).toHaveLength(100)
    expect(transcript[0].text).toBe('line 5')
    expect(transcript.at(-1)?.text).toBe('line 104')
    service.stop()
  })

  it('sends set_action/set_frequency/set_frequency_com2 as raw text, not JSON', () => {
    const { ctor, instances } = makeCtor()
    const service = new BeyondAtcService('localhost', BEYONDATC_PORT, ctor)
    service.start()
    instances[0].simulateOpen()

    service.setAction('Radio Check')
    service.setFrequency('118.850')
    service.setFrequencyCom2('121.700')

    expect(instances[0].sent).toEqual(['set_action: Radio Check', 'set_frequency: 118.850', 'set_frequency_com2: 121.700'])
    service.stop()
  })

  it('does not send a command while disconnected', () => {
    const { ctor, instances } = makeCtor()
    const service = new BeyondAtcService('localhost', BEYONDATC_PORT, ctor)
    service.start() // connecting, not yet open

    service.setAction('Radio Check')

    expect(instances[0].sent).toEqual([])
    service.stop()
  })

  it('reconnects with GSX-matching backoff after a close', () => {
    const { ctor, instances } = makeCtor()
    const service = new BeyondAtcService('localhost', BEYONDATC_PORT, ctor)
    service.start()
    instances[0].simulateOpen()

    instances[0].close()
    expect(service.getStatus().state).toBe('disconnected')
    expect(instances).toHaveLength(1)

    vi.advanceTimersByTime(250)
    expect(instances).toHaveLength(2)
    instances[1].simulateOpen()
    expect(service.getStatus()).toEqual({ state: 'connected', lastError: null })
    service.stop()
  })

  it('does not reconnect after stop()', () => {
    const { ctor, instances } = makeCtor()
    const service = new BeyondAtcService('localhost', BEYONDATC_PORT, ctor)
    service.start()
    instances[0].simulateOpen()

    service.stop()
    instances[0].emit('close', {})

    vi.advanceTimersByTime(5_000)
    expect(instances).toHaveLength(1)
  })

  it('reconfigure() against a new host drops old state and reconnects, keeping the port fixed', () => {
    const { ctor, instances } = makeCtor()
    const service = new BeyondAtcService('localhost', BEYONDATC_PORT, ctor)
    service.start()
    instances[0].simulateOpen()
    instances[0].simulateLine('Facility: Brisbane Delivery|118.850')

    service.reconfigure('192.168.1.50')

    expect(instances[0].closed).toBe(true)
    expect(instances[1].url).toBe(`ws://192.168.1.50:${BEYONDATC_PORT}/`)
    expect(service.getState().facility).toBeNull() // stale state from the old connection is gone
    service.stop()
  })
})
