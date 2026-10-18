import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SimTelemetry } from '@shared/ipc'
import { parseFlightFixture } from '../sim/flight-fixture'
import { ReplaySimConnectService } from '../sim/ReplaySimConnectService'
import { CAPTURE_FORMAT, FlightCapture, isFlightId, KEPT_DIR, pruneCaptures } from './flight-capture'

const TICK = {
  latitude: 22.3089,
  longitude: 113.9146,
  groundSpeedMs: 0,
  onGround: true,
  title: 'A350'
} as SimTelemetry

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'winglog-capture-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const lines = (path: string): unknown[] =>
  readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))

describe('FlightCapture', () => {
  it('writes a header, then every stream with its offset from the start, in the replay fixture format', async () => {
    let now = Date.parse('2026-10-06T19:00:00.000Z')
    const capture = new FlightCapture(join(dir, 'captures'), () => now)

    const path = capture.start(232, 'Airbus A350-900')
    expect(capture.isRecording).toBe(true)
    expect(capture.currentPath).toBe(path)
    capture.telemetry(TICK)
    now += 250
    capture.beyondAtc('in', 'InfoBoxes: [...]')
    now += 250
    capture.gsx('out', '{"type":"command","verb":"search"}')
    now += 500
    capture.paused(true)
    capture.stop()
    expect(capture.isRecording).toBe(false)

    await vi.waitFor(() => expect(lines(path)).toHaveLength(5))
    expect(path).toMatch(/flight-232-2026-10-06T19-00-00-000Z\.ndjson$/)
    expect(lines(path)).toEqual([
      expect.objectContaining({
        format: CAPTURE_FORMAT,
        flightId: 232,
        aircraftType: 'Airbus A350-900',
        capturedAt: '2026-10-06T19:00:00.000Z'
      }),
      { type: 'telemetry', tOffsetMs: 0, data: TICK },
      { type: 'beyondatc', tOffsetMs: 250, direction: 'in', text: 'InfoBoxes: [...]' },
      { type: 'gsx', tOffsetMs: 500, direction: 'out', text: '{"type":"command","verb":"search"}' },
      { type: 'paused', tOffsetMs: 1000, value: true }
    ])
  })

  it('is a file the replay reads: the sim stream plays, the other streams are skipped', async () => {
    let now = 0
    const capture = new FlightCapture(dir, () => now)
    const path = capture.start(1, 'A320')
    capture.telemetry({ ...TICK, latitude: 1 })
    capture.beyondAtc('in', 'CommsState: ready')
    now = 1000
    capture.telemetry({ ...TICK, latitude: 2 })
    capture.stop()
    await vi.waitFor(() => expect(lines(path)).toHaveLength(4))

    expect(parseFlightFixture(readFileSync(path, 'utf8')).events).toHaveLength(3)
    const replay = new ReplaySimConnectService(path, { mode: 'instant' })
    const lats: number[] = []
    replay.on('telemetry', (t) => lats.push(t.latitude))
    const done = new Promise<void>((resolve) => replay.on('replayComplete', () => resolve()))
    replay.start()
    await done
    expect(lats).toEqual([1, 2])
  })

  it('ignores events when not recording, and starting again finishes the open capture first', async () => {
    const capture = new FlightCapture(dir, () => 0)
    capture.telemetry(TICK)
    capture.stop()
    expect(readdirSync(dir)).toEqual([])

    const first = capture.start(1, 'A320')
    const second = capture.start(2, 'A320')
    expect(second).not.toBe(first)
    capture.stop()
    await vi.waitFor(() => expect(lines(first)).toHaveLength(1))
  })
})

describe('pruneCaptures', () => {
  function capture(name: string, ageSeconds: number): void {
    const path = join(dir, name)
    writeFileSync(path, '{}\n')
    const t = Date.now() / 1000 - ageSeconds
    utimesSync(path, t, t)
  }

  it('keeps the newest captures and deletes the rest, never touching kept/ or other files', () => {
    capture('flight-1.ndjson', 300)
    capture('flight-2.ndjson', 200)
    capture('flight-3.ndjson', 100)
    writeFileSync(join(dir, 'notes.txt'), 'mine')
    mkdirSync(join(dir, KEPT_DIR))
    writeFileSync(join(dir, KEPT_DIR, 'flight-0.ndjson'), '{}\n')

    expect(pruneCaptures(dir, 2)).toEqual(['flight-1.ndjson'])
    expect(readdirSync(dir).sort()).toEqual(['flight-2.ndjson', 'flight-3.ndjson', KEPT_DIR, 'notes.txt'])
    expect(readdirSync(join(dir, KEPT_DIR))).toEqual(['flight-0.ndjson'])
  })

  it('does nothing for a folder that does not exist yet', () => {
    expect(pruneCaptures(join(dir, 'missing'), 50)).toEqual([])
  })

  it('makes room when a capture starts, so the new one is always kept', async () => {
    capture('flight-1.ndjson', 300)
    capture('flight-2.ndjson', 200)
    const recorder = new FlightCapture(dir, Date.now, 2)
    const path = recorder.start(3, 'A320')
    recorder.stop()

    // The write stream creates its file asynchronously.
    await vi.waitFor(() =>
      expect(readdirSync(dir).sort()).toEqual(['flight-2.ndjson', path.split(/[\\/]/).at(-1)].sort())
    )
  })
})

describe('keeping a capture', () => {
  it('moves a finished flight’s captures into kept/, where pruning never reaches', () => {
    const captures = join(dir, 'captures')
    mkdirSync(captures)
    writeFileSync(join(captures, 'flight-7-2026-10-01T10-00-00-000Z.ndjson'), '{}\n')
    writeFileSync(join(captures, 'flight-70-2026-10-01T11-00-00-000Z.ndjson'), '{}\n')
    const capture = new FlightCapture(captures)

    expect(capture.keepState(7)).toBe('auto')
    expect(capture.keep(7)).toBe('kept')
    expect(readdirSync(join(captures, KEPT_DIR))).toEqual(['flight-7-2026-10-01T10-00-00-000Z.ndjson'])
    // Flight 70 shares the digits, not the flight.
    expect(capture.keepState(70)).toBe('auto')
    expect(capture.keepState(8)).toBe('none')
  })

  it('keeps the flight being recorded once its file is closed', async () => {
    const captures = join(dir, 'captures')
    const capture = new FlightCapture(captures)
    const path = capture.start(9, 'A350')
    capture.telemetry(TICK)

    expect(capture.keep(9)).toBe('kept')
    capture.stop()

    await vi.waitFor(() => expect(readdirSync(join(captures, KEPT_DIR))).toEqual([basename(path)]))
    expect(capture.keepState(9)).toBe('kept')
  })

  it('has nothing to keep before any capture exists', () => {
    const capture = new FlightCapture(join(dir, 'never-created'))
    expect(capture.keep(1)).toBe('none')
  })
})

describe('isFlightId', () => {
  it('accepts only a positive integer, so a renderer value can only name a capture file', () => {
    expect(isFlightId(232)).toBe(true)
    expect([0, -1, 1.5, '232', '../x', null].map(isFlightId)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false
    ])
  })
})
