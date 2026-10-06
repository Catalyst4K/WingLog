import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { BeyondAtcState, SimTelemetry } from '@shared/ipc'
import { DevDiagnostics, type BeyondAtcEvents, type GsxEvents, type SimEvents, type TrackingEvents } from './dev-diagnostics'
import type { FlightCapture } from './flight-capture'

function fakeCapture() {
  const calls: unknown[][] = []
  let recording = false
  const capture = {
    get isRecording() {
      return recording
    },
    start: vi.fn((flightId: number, aircraftType: string) => {
      recording = true
      calls.push(['start', flightId, aircraftType])
      return `C:/captures/flight-${flightId}.ndjson`
    }),
    stop: vi.fn(() => {
      recording = false
      calls.push(['stop'])
    }),
    telemetry: vi.fn((t: SimTelemetry) => calls.push(['telemetry', t.latitude])),
    paused: vi.fn((v: boolean) => calls.push(['paused', v])),
    beyondAtc: vi.fn((d: string, text: string) => calls.push(['beyondatc', d, text])),
    gsx: vi.fn((d: string, text: string) => calls.push(['gsx', d, text]))
  }
  return { capture: capture as unknown as FlightCapture, calls }
}

function setup() {
  const lines: string[] = []
  const diag = vi.fn((category: string, message: string, data?: unknown) =>
    lines.push(`${category}: ${message}${data === undefined ? '' : ` ${JSON.stringify(data)}`}`)
  )
  const { capture, calls } = fakeCapture()
  const dev = new DevDiagnostics(diag, capture)
  return { dev, lines, calls }
}

const tick = (overrides: Partial<SimTelemetry>) =>
  ({ latitude: 22.3, longitude: 113.9, onGround: true, groundSpeedMs: 0, altitudeAglM: 0, verticalSpeedMs: 0, title: 'A350', ...overrides }) as SimTelemetry

describe('DevDiagnostics', () => {
  it('captures a tracked flight from start to completion, and only while it is tracked', () => {
    const { dev, lines, calls } = setup()
    const tracking = new EventEmitter()
    const sim = Object.assign(new EventEmitter(), { getLastTelemetry: () => tick({ title: 'iniBuilds A350-900' }) })
    dev.attachTracking(tracking as unknown as TrackingEvents, sim as unknown as SimEvents)

    sim.emit('telemetry', tick({ latitude: 1 }))
    tracking.emit('started', 231)
    sim.emit('telemetry', tick({ latitude: 2 }))
    sim.emit('paused', true)
    tracking.emit('completed', 231)
    sim.emit('telemetry', tick({ latitude: 3 }))

    expect(calls).toEqual([['start', 231, 'iniBuilds A350-900'], ['telemetry', 2], ['paused', true], ['stop']])
    expect(lines).toEqual([
      'capture: started for flight 231 {"path":"C:/captures/flight-231.ndjson"}',
      'phase: sim paused',
      'capture: completed: flight 231'
    ])
  })

  it('stops the capture when tracking is cancelled, and logs each phase change with its tick', () => {
    const { dev, lines, calls } = setup()
    const tracking = new EventEmitter()
    const sim = Object.assign(new EventEmitter(), { getLastTelemetry: () => undefined })
    dev.attachTracking(tracking as unknown as TrackingEvents, sim as unknown as SimEvents)

    tracking.emit('started', 7)
    tracking.emit('phaseChanged', { from: 'taxi', to: 'takeoff', telemetry: tick({ groundSpeedMs: 41.2, latitude: 22.31 }) })
    tracking.emit('stopped', 7)

    expect(calls[0]).toEqual(['start', 7, 'unknown'])
    expect(calls.at(-1)).toEqual(['stop'])
    expect(lines[1]).toBe('phase: taxi -> takeoff {"onGround":true,"groundSpeedMs":41.2,"altitudeAglM":0,"verticalSpeedMs":0,"lat":22.31,"lon":113.9}')
    expect(lines.at(-1)).toBe('capture: stopped: flight 7')
  })

  it("logs every BeyondATC message, records it while tracking, and logs what WingLog read from the boxes and ATC's lines", () => {
    const { dev, lines, calls } = setup()
    const tracking = new EventEmitter()
    const sim = Object.assign(new EventEmitter(), { getLastTelemetry: () => undefined })
    dev.attachTracking(tracking as unknown as TrackingEvents, sim as unknown as SimEvents)
    const beyondAtc = new EventEmitter()
    dev.attachBeyondAtc(beyondAtc as unknown as BeyondAtcEvents)

    beyondAtc.emit('raw', { direction: 'in', text: 'CommsState: ready' })
    tracking.emit('started', 1)
    beyondAtc.emit('raw', { direction: 'out', text: 'set_action: Radio Check' })
    // Real boxes, VHHH 2026-10-05.
    const infoBoxes = [
      { title: 'Taxi Via 1', info: 'B' },
      { title: 'Taxi Via 2', info: 'V' },
      { title: 'Hold Position', info: 'J1' }
    ]
    beyondAtc.emit('state', { infoBoxes } as BeyondAtcState)
    beyondAtc.emit('state', { infoBoxes } as BeyondAtcState) // unchanged: not logged again
    beyondAtc.emit('transcript', [
      { speaker: 'player', text: 'Request taxi', ts: 1 },
      { speaker: 'atc', text: 'Cathay 251, taxi via B, V, hold short of runway 07R.', ts: 2 }
    ])
    beyondAtc.emit('transcript', [{ speaker: 'atc', text: 'Cathay 251, taxi via B, V, hold short of runway 07R.', ts: 2 }])

    expect(calls).toEqual([['start', 1, 'unknown'], ['beyondatc', 'out', 'set_action: Radio Check']])
    expect(lines.filter((l) => l.startsWith('beyondatc:'))).toEqual([
      'beyondatc: in "CommsState: ready"',
      'beyondatc: out "set_action: Radio Check"'
    ])
    const atc = lines.filter((l) => l.startsWith('atc:'))
    expect(atc).toHaveLength(2)
    expect(atc[0]).toContain('"taxiVia":["B","V"]')
    expect(atc[0]).toContain('"holdPosition":"J1"')
    expect(atc[1]).toBe('atc: Cathay 251, taxi via B, V, hold short of runway 07R. {"holdShortRunway":"07R"}')
  })

  it('logs every GSX message and command, and records them while tracking', () => {
    const { dev, lines, calls } = setup()
    const tracking = new EventEmitter()
    const sim = Object.assign(new EventEmitter(), { getLastTelemetry: () => undefined })
    dev.attachTracking(tracking as unknown as TrackingEvents, sim as unknown as SimEvents)
    const gsx = new EventEmitter()
    dev.attachGsx(gsx as unknown as GsxEvents)

    gsx.emit('raw', { direction: 'in', text: '{"type":"snapshot"}' })
    tracking.emit('started', 1)
    gsx.emit('raw', { direction: 'out', text: '{"type":"command"}' })

    expect(calls.at(-1)).toEqual(['gsx', 'out', '{"type":"command"}'])
    expect(lines.filter((l) => l.startsWith('gsx:'))).toHaveLength(2)
  })
})
