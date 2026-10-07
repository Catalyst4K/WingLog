import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_BEYONDATC_STATE } from '@shared/beyondatc-state'
import { logger } from '../logging/logger'
import {
  BEYONDATC_PORT,
  BeyondAtcService,
  e2eBeyondAtcPort,
  validFrequency,
  type WebSocketCtor
} from './BeyondAtcService'

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

    expect(service.getState()).toEqual(EMPTY_BEYONDATC_STATE)
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
      actions: [],
      autoTune: null,
      autoRespond: null,
      frequencies: [],
      infoBoxes: [],
      infoBoxesAt: null,
      assignedGate: null
    })
    service.stop()
  })

  it('remembers the gate BeyondATC assigned after its box is replaced (ZJSY, 2026-10-05)', () => {
    const { ctor, instances } = makeCtor()
    const service = new BeyondAtcService('localhost', BEYONDATC_PORT, ctor)
    service.start()
    instances[0].simulateOpen()
    instances[0].simulateLine('InfoBoxes: []')
    expect(service.getState()).toMatchObject({ infoBoxesAt: null, assignedGate: null })

    instances[0].simulateLine('InfoBoxes: [{"title":"Expect Gate","info":"Gate 102"}]')
    expect(service.getState()).toMatchObject({ assignedGate: '102' })
    expect(service.getState().infoBoxesAt).toEqual(expect.any(Number))

    instances[0].simulateLine('InfoBoxes: [{"title":"Tower Frequency","info":"118.15"}]')
    expect(service.getState().assignedGate).toBe('102')

    instances[0].simulateLine(
      'InfoBoxes: [{"title":"Taxi to Gate","info":"Gate 104"},{"title":"Taxi Via 1","info":"A4"}]'
    )
    expect(service.getState().assignedGate).toBe('104')
    service.stop()
  })

  it("parses BeyondATC's real InfoBoxes, the facts its own menu shows (EGLL, 2026-10-05)", () => {
    const { ctor, instances } = makeCtor()
    const service = new BeyondAtcService('localhost', BEYONDATC_PORT, ctor)
    service.start()
    instances[0].simulateOpen()
    instances[0].simulateLine(
      'InfoBoxes: [{"title":"Taxi to Gate","info":"Gate 411"},{"title":"Taxi Via 1","info":"A"},{"title":"Taxi Via 2","info":"R"},{"title":"Taxi Via 3","info":"N5W"},{"title":"Taxi Via 4","info":"S5W"},{"title":"Taxi Via 5","info":"W"},{"title":"Taxi Via 6","info":"LINK 44"},{"title":"Taxi Via 7","info":"T"},{"title":"ATIS Current","info":"C"}]'
    )

    expect(service.getState().infoBoxes.slice(0, 2)).toEqual([
      { title: 'Taxi to Gate', info: 'Gate 411' },
      { title: 'Taxi Via 1', info: 'A' }
    ])
    expect(service.getState().infoBoxes).toHaveLength(9)

    // Malformed entries are skipped, malformed JSON clears the list rather than throwing.
    instances[0].simulateLine('InfoBoxes: [{"title":"Taxi to Gate","info":"Gate 411"},{"title":3},"x"]')
    expect(service.getState().infoBoxes).toEqual([{ title: 'Taxi to Gate', info: 'Gate 411' }])
    instances[0].simulateLine('InfoBoxes: [{not json')
    expect(service.getState().infoBoxes).toEqual([])
    service.stop()
  })

  it('logs InfoBoxes to main.log on each change only, raw, to record what BeyondATC uses per phase', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
    const { ctor, instances } = makeCtor()
    const service = new BeyondAtcService('localhost', BEYONDATC_PORT, ctor)
    service.start()
    instances[0].simulateOpen()
    const line = 'InfoBoxes: [{"title":"Taxi to Gate","info":"Gate 411"}]'
    instances[0].simulateLine(line)
    instances[0].simulateLine(line)
    instances[0].simulateLine('InfoBoxes: []')

    const logged = info.mock.calls
      .map((c) => c[0])
      .filter((m) => String(m).startsWith('[beyondatc] InfoBoxes'))
    expect(logged).toEqual([
      '[beyondatc] InfoBoxes [{"title":"Taxi to Gate","info":"Gate 411"}]',
      '[beyondatc] InfoBoxes []'
    ])
    info.mockRestore()
    service.stop()
  })

  it('parses AutoTune/AutoRespond as bare lowercase true/false, confirmed live 2026-09-29', () => {
    const { ctor, instances } = makeCtor()
    const service = new BeyondAtcService('localhost', BEYONDATC_PORT, ctor)
    service.start()
    instances[0].simulateOpen()

    instances[0].simulateLine('AutoTune: true')
    instances[0].simulateLine('AutoRespond: false')

    expect(service.getState().autoTune).toBe(true)
    expect(service.getState().autoRespond).toBe(false)
    service.stop()
  })

  it('resolves an unrecognised AutoTune/AutoRespond value to null rather than guessing', () => {
    const { ctor, instances } = makeCtor()
    const service = new BeyondAtcService('localhost', BEYONDATC_PORT, ctor)
    service.start()
    instances[0].simulateOpen()

    instances[0].simulateLine('AutoTune: True')

    expect(service.getState().autoTune).toBeNull()
    service.stop()
  })

  it('parses the real Frequencies capture into structured options', () => {
    const { ctor, instances } = makeCtor()
    const service = new BeyondAtcService('localhost', BEYONDATC_PORT, ctor)
    service.start()
    instances[0].simulateOpen()

    instances[0].simulateLine(
      'Frequencies: [{"airport":"WSSS","airportName":"Changi","frequency":"124.050","name":"SINGAPORE APPROACH","type":"Approach","stationType":"","runways":"02L"},' +
        '{"airport":"","airportName":"","frequency":"134.400","name":"Singapore Radar","type":"Center","stationType":"","runways":"","cpdlcLogonCode":"WSJC"}]'
    )

    expect(service.getState().frequencies).toEqual([
      {
        airport: 'WSSS',
        airportName: 'Changi',
        frequency: '124.050',
        name: 'SINGAPORE APPROACH',
        type: 'Approach',
        stationType: '',
        runways: '02L'
      },
      {
        airport: '',
        airportName: '',
        frequency: '134.400',
        name: 'Singapore Radar',
        type: 'Center',
        stationType: '',
        runways: '',
        cpdlcLogonCode: 'WSJC'
      }
    ])
    service.stop()
  })

  it('drops a Frequencies entry that does not match the confirmed shape', () => {
    const { ctor, instances } = makeCtor()
    const service = new BeyondAtcService('localhost', BEYONDATC_PORT, ctor)
    service.start()
    instances[0].simulateOpen()

    instances[0].simulateLine('Frequencies: [{"frequency":"124.050"}]')

    expect(service.getState().frequencies).toEqual([])
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

  it("ignores unrecognised keys, out of this plan's scope", () => {
    const { ctor, instances } = makeCtor()
    const service = new BeyondAtcService('localhost', BEYONDATC_PORT, ctor)
    service.start()
    instances[0].simulateOpen()

    expect(() => instances[0].simulateLine('DATIS: YBBN|D|Brisbane information Delta.')).not.toThrow()
    expect(() => instances[0].simulateLine('DATIS_END:')).not.toThrow()
    expect(service.getState()).toEqual(EMPTY_BEYONDATC_STATE)
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

    instances[0].simulateLine(
      'Facility: Brisbane Delivery|118.850\r\nCallsign: {"full": "Cathay 116 Heavy", "shortForm": "CPA116"}\r\n'
    )

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

  it('requests the frequency list as soon as the connection opens', () => {
    const { ctor, instances } = makeCtor()
    const service = new BeyondAtcService('localhost', BEYONDATC_PORT, ctor)
    service.start()
    instances[0].simulateOpen()

    expect(instances[0].sent).toEqual(['frequencies'])
    service.stop()
  })

  it('re-requests frequencies when state arrives while the list is still empty (BeyondATC not ready at open)', () => {
    vi.useFakeTimers()
    try {
      const { ctor, instances } = makeCtor()
      const service = new BeyondAtcService('localhost', BEYONDATC_PORT, ctor)
      service.start()
      instances[0].simulateOpen()
      instances[0].simulateLine('Frequencies: []')
      instances[0].sent.length = 0

      // Inside the 2s throttle window: no duplicate request.
      instances[0].simulateLine('Facility: Singapore Delivery 121.650')
      expect(instances[0].sent).toEqual([])

      vi.advanceTimersByTime(2500)
      instances[0].simulateLine('Progress: {"from": "WSSS", "to": "ZSPD", "pct": 0}')
      expect(instances[0].sent).toEqual(['frequencies'])

      // Once populated, an unchanged route doesn't re-ask; a changed one does.
      instances[0].simulateLine(
        'Frequencies: [{"airport":"WSSS","airportName":"Changi","frequency":"121.650","name":"Singapore Delivery","type":"Clearance","stationType":"Delivery","runways":""}]'
      )
      instances[0].sent.length = 0
      vi.advanceTimersByTime(2500)
      instances[0].simulateLine('Progress: {"from": "WSSS", "to": "ZSPD", "pct": 5}')
      expect(instances[0].sent).toEqual([])
      instances[0].simulateLine('Progress: {"from": "WSSS", "to": "VHHH", "pct": 5}')
      expect(instances[0].sent).toEqual(['frequencies'])
      service.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends set_action/set_frequency/set_frequency_com2/set_autotune/set_autorespond as raw text, not JSON', () => {
    const { ctor, instances } = makeCtor()
    const service = new BeyondAtcService('localhost', BEYONDATC_PORT, ctor)
    service.start()
    instances[0].simulateOpen()
    instances[0].simulateLine('Actions: [Request IFR Clearance¬Radio Check¬]')
    instances[0].sent.length = 0 // clear the automatic `frequencies` request from open, above

    service.setAction('Radio Check')
    service.setFrequency('118.850')
    service.setFrequencyCom2('121.700')
    service.setAutoTune(false)
    service.setAutoRespond(true)

    expect(instances[0].sent).toEqual([
      'set_action: Radio Check',
      'set_frequency: 118.850',
      'set_frequency_com2: 121.700',
      'set_autotune: false',
      'set_autorespond: true'
    ])
    service.stop()
  })

  it('only sends an action BeyondATC is offering right now, and only as one protocol line', () => {
    const { ctor, instances } = makeCtor()
    const service = new BeyondAtcService('localhost', BEYONDATC_PORT, ctor)
    service.start()
    instances[0].simulateOpen()
    // Real capture, 2026-09-25.
    instances[0].simulateLine('Actions: [Request IFR Clearance¬Request Departure Runway Change¬Radio Check¬]')
    instances[0].sent.length = 0

    service.setAction('Request Taxi') // not on offer right now
    service.setAction('Radio Check\nset_frequency: 121.500') // a second line smuggled in
    service.setAction(42)
    service.setAction(undefined)
    service.setAction('x'.repeat(10_000))
    expect(instances[0].sent).toEqual([])

    service.setAction('Request IFR Clearance')
    expect(instances[0].sent).toEqual(['set_action: Request IFR Clearance'])
    service.stop()
  })

  it('only sends a real airband frequency, and only a boolean for AutoTune/AutoRespond', () => {
    const { ctor, instances } = makeCtor()
    const service = new BeyondAtcService('localhost', BEYONDATC_PORT, ctor)
    service.start()
    instances[0].simulateOpen()
    instances[0].sent.length = 0

    service.setFrequency('121.7\nset_action: Radio Check')
    service.setFrequency(121.7)
    service.setFrequencyCom2('hello')
    service.setAutoTune('true')
    service.setAutoRespond(1)
    expect(instances[0].sent).toEqual([])

    service.setFrequency(' 121.7 ')
    service.setFrequencyCom2('122.800')
    service.setAutoTune(true)
    expect(instances[0].sent).toEqual([
      'set_frequency: 121.7',
      'set_frequency_com2: 122.800',
      'set_autotune: true'
    ])
    service.stop()
  })

  it('accepts VHF airband frequencies as typed and rejects everything else', () => {
    // Real values: YBBN delivery/ground and VHHH tower, 2026-10-02, plus a bare MHz.
    expect(validFrequency('118.850')).toBe('118.850')
    expect(validFrequency('121.7')).toBe('121.7')
    expect(validFrequency('122.825')).toBe('122.825')
    expect(validFrequency('136.975')).toBe('136.975')
    expect(validFrequency('121')).toBe('121')
    expect(validFrequency('117.950')).toBeNull() // VOR band, below the comm band
    expect(validFrequency('137.000')).toBeNull()
    expect(validFrequency('121.7255')).toBeNull()
    expect(validFrequency('121,7')).toBeNull()
    expect(validFrequency('')).toBeNull()
    expect(validFrequency(null)).toBeNull()
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

describe('BeyondAtcService raw messages (dev build capture)', () => {
  it('emits every frame received, unsplit, and every command sent', () => {
    const { ctor, instances } = makeCtor()
    const service = new BeyondAtcService('localhost', BEYONDATC_PORT, ctor)
    const raw: { direction: 'in' | 'out'; text: string }[] = []
    service.on('raw', (message) => raw.push(message))
    service.start()
    instances[0].simulateOpen()
    instances[0].simulateLine('Actions: [Radio Check¬]\nCommsState: ready')
    service.setAction('Radio Check')

    expect(raw).toEqual([
      { direction: 'out', text: 'frequencies' },
      { direction: 'in', text: 'Actions: [Radio Check¬]\nCommsState: ready' },
      { direction: 'out', text: 'set_action: Radio Check' }
    ])
    service.stop()
  })
})

describe('e2eBeyondAtcPort', () => {
  it('uses a valid port from the e2e variable, and the real port for anything else', () => {
    expect(e2eBeyondAtcPort('43123')).toBe(43123)
    expect([undefined, '', 'abc', '0', '70000', '41716.5'].map(e2eBeyondAtcPort)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    ])
  })
})
