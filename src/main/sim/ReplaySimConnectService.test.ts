import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SimConnectionStatus, SimTelemetry } from '@shared/ipc'
import type { FlightFixtureEvent, FlightFixtureHeader } from './flight-fixture'
import { ReplaySimConnectService } from './ReplaySimConnectService'

function telemetry(overrides: Partial<SimTelemetry> = {}): SimTelemetry {
  return {
    latitude: 51.4775,
    longitude: -0.4614,
    altitudeM: 25,
    pressureAltitudeM: 25,
    altitudeAglM: 0,
    verticalSpeedMs: 0,
    indicatedAirspeedMs: 0,
    trueAirspeedMs: 0,
    machSpeed: 0,
    groundSpeedMs: 0,
    headingTrueDeg: 270,
    pitchDeg: 0,
    bankDeg: 0,
    onGround: true,
    gForce: 1,
    fuelTotalKg: 10000,
    totalWeightKg: 70000,
    windSpeedMs: 3,
    windDirectionDeg: 250,
    engineCombustion1: false,
    gearHandlePosition: 1,
    flapsHandleIndex: 0,
    parkingBrakeOn: true,
    atcId: 'TEST',
    atcModel: 'A320',
    title: 'Test Aircraft',
    simRate: 1,
    slewActive: false,
    ...overrides
  }
}

const HEADER: FlightFixtureHeader = {
  scenario: 'unit-test',
  aircraftType: 'Test Aircraft',
  capturedAt: '2026-09-14T00:00:00.000Z',
  notes: 'fixture for ReplaySimConnectService tests'
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'winglog-replay-test-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.useRealTimers()
})

function writeFixture(events: FlightFixtureEvent[], header: FlightFixtureHeader = HEADER): string {
  const path = join(dir, 'fixture.ndjson')
  const lines = [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))]
  writeFileSync(path, lines.join('\n') + '\n')
  return path
}

describe('ReplaySimConnectService', () => {
  it('parses and exposes the fixture header', () => {
    const path = writeFixture([{ type: 'telemetry', tOffsetMs: 0, data: telemetry() }])
    const service = new ReplaySimConnectService(path)
    expect(service.header).toEqual(HEADER)
  })

  it('throws if the fixture has no telemetry events', () => {
    const path = writeFixture([{ type: 'paused', tOffsetMs: 0, value: true }])
    expect(() => new ReplaySimConnectService(path)).toThrow('no telemetry events')
  })

  it('returns the first tick immediately on construction, before start() is called', () => {
    const first = telemetry({ latitude: 1, longitude: 2 })
    const path = writeFixture([
      { type: 'telemetry', tOffsetMs: 0, data: first },
      { type: 'telemetry', tOffsetMs: 1000, data: telemetry({ latitude: 9, longitude: 9 }) }
    ])
    const service = new ReplaySimConnectService(path)
    expect(service.getLastTelemetry()).toEqual(first)
    expect(service.getStatus()).toEqual({ state: 'disconnected' })
  })

  it('instant mode replays every tick and paused event, then emits replayComplete', async () => {
    const path = writeFixture([
      { type: 'telemetry', tOffsetMs: 0, data: telemetry({ latitude: 1 }) },
      { type: 'paused', tOffsetMs: 500, value: true },
      { type: 'telemetry', tOffsetMs: 1000, data: telemetry({ latitude: 2 }) },
      { type: 'paused', tOffsetMs: 1500, value: false },
      { type: 'telemetry', tOffsetMs: 2000, data: telemetry({ latitude: 3 }) }
    ])
    const service = new ReplaySimConnectService(path, { mode: 'instant' })
    const statuses: SimConnectionStatus[] = []
    const lats: number[] = []
    const paused: boolean[] = []
    service.on('status', (s) => statuses.push(s))
    service.on('telemetry', (t) => lats.push(t.latitude))
    service.on('paused', (p) => paused.push(p))

    const complete = new Promise<void>((resolve) => service.on('replayComplete', resolve))
    service.start()
    await complete

    expect(statuses).toEqual([{ state: 'connected', simConnectVersion: 'replay' }])
    expect(lats).toEqual([1, 2, 3])
    expect(paused).toEqual([true, false])
    expect(service.getLastTelemetry()?.latitude).toBe(3)
    expect(service.getStatus()).toEqual({ state: 'connected', simConnectVersion: 'replay' })
  })

  it('paced mode schedules each tick at its recorded offset delta, divided by speedMultiplier', async () => {
    vi.useFakeTimers()
    const path = writeFixture([
      { type: 'telemetry', tOffsetMs: 0, data: telemetry({ latitude: 1 }) },
      { type: 'telemetry', tOffsetMs: 1000, data: telemetry({ latitude: 2 }) },
      { type: 'telemetry', tOffsetMs: 6000, data: telemetry({ latitude: 3 }) }
    ])
    const service = new ReplaySimConnectService(path, { mode: 'paced', speedMultiplier: 10 })
    const lats: number[] = []
    service.on('telemetry', (t) => lats.push(t.latitude))

    service.start()
    await vi.advanceTimersByTimeAsync(0) // first tick's delta is 0 — still scheduled, not synchronous
    expect(lats).toEqual([1])

    await vi.advanceTimersByTimeAsync(99) // 1000ms / 10x = 100ms — not there yet
    expect(lats).toEqual([1])

    await vi.advanceTimersByTimeAsync(1) // crosses the 100ms mark
    expect(lats).toEqual([1, 2])

    await vi.advanceTimersByTimeAsync(499) // (6000-1000)ms / 10x = 500ms — not there yet
    expect(lats).toEqual([1, 2])

    await vi.advanceTimersByTimeAsync(1)
    expect(lats).toEqual([1, 2, 3])
  })

  it('stop() halts replay before it finishes and no further ticks are emitted', async () => {
    vi.useFakeTimers()
    const path = writeFixture([
      { type: 'telemetry', tOffsetMs: 0, data: telemetry({ latitude: 1 }) },
      { type: 'telemetry', tOffsetMs: 1000, data: telemetry({ latitude: 2 }) }
    ])
    const service = new ReplaySimConnectService(path, { mode: 'paced' })
    const lats: number[] = []
    let completed = false
    service.on('telemetry', (t) => lats.push(t.latitude))
    service.on('replayComplete', () => {
      completed = true
    })

    service.start()
    await vi.advanceTimersByTimeAsync(0) // let the first (zero-delta) tick fire
    expect(lats).toEqual([1])

    service.stop()
    await vi.advanceTimersByTimeAsync(5000)

    expect(lats).toEqual([1]) // the second tick never fires — its timer was cleared
    expect(completed).toBe(false)
    expect(service.getStatus()).toEqual({ state: 'disconnected' })
  })
})
