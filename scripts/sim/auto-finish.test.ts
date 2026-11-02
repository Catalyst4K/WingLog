import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ParsedFlightFixture } from '../../src/main/sim/flight-fixture'
import type { SimTelemetry } from '../../src/shared/ipc'
import {
  arrivalTicks,
  finalStopMs,
  lastRunStartMs,
  liveFinish,
  listCaptures,
  verdictOf,
  type ArrivalFindings,
  type ArrivalTick
} from './auto-finish'
import { arrivalFigure, autoFinishReport, clockUtc, stretches } from './auto-finish-report'

/** A tick `s` seconds in. */
const tick = (s: number, groundSpeedMs: number, engine1: boolean, parkingBrakeOn = false): ArrivalTick => ({
  tOffsetMs: s * 1000,
  groundSpeedMs,
  engine1,
  parkingBrakeOn
})

// Flight 259's arrival in brief: taxiing in, stopped at the stand, engine 1 off, the brake never seen.
const TICKS = [
  tick(0, 6, true),
  tick(1, 3, true),
  tick(2, 0.1, true),
  tick(3, 0, true),
  tick(4, 0, false),
  tick(5, 0, false)
]
const CAPTURED_AT_MS = Date.UTC(2026, 10, 2, 13, 11, 36, 577)

function findings(overrides: Partial<ArrivalFindings> = {}): ArrivalFindings {
  return {
    flightId: 259,
    route: 'ENBR to EGCC',
    aircraft: 'FenixA320 IAE SL',
    capturedAtMs: CAPTURED_AT_MS,
    touchdownMs: 0,
    endMs: 5000,
    ticks: TICKS,
    live: { kind: 'byHand', atMs: 5000 },
    replayFinishMs: 4000,
    ...overrides
  }
}

describe('listCaptures', () => {
  it('finds the flight captures in captures/ and captures/kept/, and nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'winglog-auto-finish-'))
    mkdirSync(join(dir, 'captures', 'kept'), { recursive: true })
    writeFileSync(join(dir, 'captures', 'flight-259-a.ndjson'), '')
    writeFileSync(join(dir, 'captures', 'notes.txt'), '')
    writeFileSync(join(dir, 'captures', 'kept', 'flight-236-b.ndjson'), '')
    expect(listCaptures(dir)).toEqual([
      join(dir, 'captures', 'flight-259-a.ndjson'),
      join(dir, 'captures', 'kept', 'flight-236-b.ndjson')
    ])
    expect(listCaptures(join(dir, 'nowhere'))).toEqual([])
  })
})

describe('arrivalTicks', () => {
  it('keeps the telemetry from the given time on, as the finish rule reads it', () => {
    const data = (groundSpeedMs: number): SimTelemetry =>
      ({ groundSpeedMs, engineCombustion1: true, parkingBrakeOn: false }) as SimTelemetry
    const capture: ParsedFlightFixture = {
      header: { scenario: 's', aircraftType: 'a', capturedAt: '2026-11-02T13:11:36.577Z', notes: '' },
      events: [
        { type: 'telemetry', tOffsetMs: 1000, data: data(70) },
        { type: 'paused', tOffsetMs: 1500, value: true },
        { type: 'telemetry', tOffsetMs: 2000, data: data(5) }
      ]
    }
    expect(arrivalTicks(capture, 2000)).toEqual([tick(2, 5, true)])
  })
})

describe('lastRunStartMs and finalStopMs', () => {
  it('find where the last run began, or null when the last tick breaks it', () => {
    expect(finalStopMs(TICKS)).toBe(2000)
    expect(lastRunStartMs(TICKS, (t) => !t.engine1)).toBe(4000)
    expect(finalStopMs([...TICKS, tick(6, 2, false)])).toBeNull()
    expect(finalStopMs([tick(0, 0, false), tick(1, 3, false), tick(2, 0, false)])).toBe(2000)
  })
})

describe('liveFinish', () => {
  const points = [{ phase: 'taxi' as const, tsUtc: '2026-11-02T15:26:11.000Z' }]
  it('is by itself with a shutdown point, by hand when completed without one, and open otherwise', () => {
    const shutdown = [...points, { phase: 'shutdown' as const, tsUtc: '2026-11-02T13:11:46.577Z' }]
    expect(
      liveFinish(shutdown, { status: 'completed', actualInUtc: '2026-11-02T13:11:46.600Z' }, CAPTURED_AT_MS)
    ).toEqual({ kind: 'auto', atMs: 10_000 })
    expect(
      liveFinish(points, { status: 'completed', actualInUtc: '2026-11-02T13:11:56.577Z' }, CAPTURED_AT_MS)
    ).toEqual({
      kind: 'byHand',
      atMs: 20_000
    })
    expect(liveFinish(points, { status: 'active', actualInUtc: null }, CAPTURED_AT_MS)).toEqual({
      kind: 'open'
    })
  })
})

describe('verdictOf', () => {
  it('names what the new rule changes', () => {
    expect(verdictOf(findings())).toBe('finishesByItself')
    expect(verdictOf(findings({ replayFinishMs: null, live: { kind: 'auto', atMs: 6000 } }))).toBe(
      'unchanged'
    )
    expect(verdictOf(findings({ replayFinishMs: null }))).toBe('unchanged')
    expect(verdictOf(findings({ replayFinishMs: null, live: { kind: 'open' } }))).toBe('stillOpen')
  })

  it('calls a finish before the final stop, or before an automatic finish today, earlier', () => {
    expect(verdictOf(findings({ replayFinishMs: 1000 }))).toBe('earlier')
    expect(verdictOf(findings({ live: { kind: 'auto', atMs: 6000 } }))).toBe('earlier')
  })
})

describe('the report', () => {
  it('draws each stretch of engine 1 and the brake', () => {
    expect(stretches(TICKS, (t) => t.engine1)).toEqual([[0, 3000]])
    expect(stretches([tick(0, 0, true), tick(1, 0, false), tick(2, 0, true)], (t) => t.engine1)).toEqual([
      [0, 0],
      [2000, 2000]
    ])
  })

  it('reads clock times in UTC', () => {
    expect(clockUtc(CAPTURED_AT_MS)).toBe('13:11:36 UTC')
  })

  it('labels the markers, escaped', () => {
    const svg = arrivalFigure(findings(), [
      { atMs: 4000, label: 'new rule <here>', colour: 'red', dashed: false }
    ])
    expect(svg).toContain('new rule &lt;here&gt;')
    expect(svg).toContain('parking brake')
  })

  it('counts the verdicts and has one section per flight, with today beside the new finish', () => {
    const report = autoFinishReport(
      [findings(), findings({ flightId: 250, replayFinishMs: null, live: { kind: 'auto', atMs: 6000 } })],
      ['flight 233 (no landing in the capture)']
    )
    expect(report.summary).toEqual([
      { label: 'Arrivals replayed', value: '2' },
      { label: 'Now finish by themselves', value: '1' },
      { label: 'Unchanged', value: '1' },
      { label: 'Finish earlier than today', value: '0' }
    ])
    expect(report.intro).toContain('flight 233 (no landing in the capture)')
    expect(report.sections.map((s) => s.title)).toEqual([
      'Flight 259: ENBR to EGCC',
      'Flight 250: ENBR to EGCC'
    ])
    const finish = report.sections[0]?.metrics.find((m) => m.label === 'Finish')
    expect(finish).toEqual({
      label: 'Finish',
      value: 'by itself at 13:11:40 UTC',
      was: 'by hand at 13:11:41 UTC'
    })
  })
})
