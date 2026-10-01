import { describe, expect, it, vi } from 'vitest'
import type { ActiveTracking, BeyondAtcState, BeyondAtcStepClimbStatus, BeyondAtcTranscriptEntry, SimTelemetry } from '@shared/ipc'
import { EMPTY_STATE } from './BeyondAtcService'
import type { AltitudeRequestOutcome, requestAltitude } from './altitude-request'
import { StepClimbController, clearedLevelFromTranscript, distanceNm, extractStepPlan } from './step-climb'

const FT = 0.3048

// Real field names/shape (simbrief-client.test.ts's fixture) with the real stepclimb_string
// from the China-crossing OFP in docs/decisions.md; fix positions made up but plausible.
function ofpJson(
  stepclimb = 'EGLL/0330/DENAK/0350/KAMUD/1130',
  fixes: Record<string, string>[] = [
    { ident: 'DENAK', altitude_feet: '35000', distance: '900', pos_lat: '45.0', pos_long: '30.0' },
    { ident: 'MIDPT', altitude_feet: '35000', distance: '1900', pos_lat: '42.0', pos_long: '50.0' },
    { ident: 'KAMUD', altitude_feet: '37073', distance: '3000', pos_lat: '40.0', pos_long: '75.0' }
  ]
): string {
  return JSON.stringify({
    fetch: { status: 'Success' },
    params: { request_id: '1', units: 'kgs' },
    origin: { icao_code: 'EGLL' },
    destination: { icao_code: 'VHHH' },
    alternate: { icao_code: 'VMMC' },
    general: { icao_airline: 'BAW', flight_number: '31', route: 'DCT', initial_altitude: '33000', stepclimb_string: stepclimb },
    aircraft: { icaocode: 'A35K', reg: 'G-XWBS', internal_id: 'A35K', is_custom: '0' },
    weights: { pax_count: '1', cargo: '0', est_zfw: '1', est_tow: '1', est_ldw: '1' },
    fuel: { plan_ramp: '1' },
    times: { sched_out: '1787860800', sched_in: '1787898900' },
    navlog: { fix: fixes }
  })
}

/** Cruising at FL330, 60 nm short of DENAK at ~470 kt. */
function telemetry(overrides: Partial<SimTelemetry> = {}): SimTelemetry {
  return {
    latitude: 45.0,
    longitude: 28.6,
    altitudeM: 33000 * FT,
    pressureAltitudeM: 33000 * FT,
    altitudeAglM: 32000 * FT,
    verticalSpeedMs: 0,
    indicatedAirspeedMs: 130,
    trueAirspeedMs: 240,
    machSpeed: 0.84,
    groundSpeedMs: 242,
    headingTrueDeg: 90,
    pitchDeg: 2,
    bankDeg: 0,
    onGround: false,
    gForce: 1,
    fuelTotalKg: 60000,
    totalWeightKg: 250000,
    windSpeedMs: 0,
    windDirectionDeg: 0,
    engineCombustion1: true,
    gearHandlePosition: 0,
    flapsHandleIndex: 0,
    parkingBrakeOn: false,
    apSelectedAltitudeM: 33000 * FT,
    atcId: '',
    atcModel: '',
    title: '',
    simRate: 1,
    slewActive: false,
    ...overrides
  }
}

function setup(opts: { phase?: ActiveTracking['phase']; outcomes?: AltitudeRequestOutcome[]; transcript?: BeyondAtcTranscriptEntry[] } = {}) {
  let now = 1_000_000
  const outcomes = [...(opts.outcomes ?? ['granted'])]
  const request = vi.fn<typeof requestAltitude>(async () => ({
    outcome: outcomes.shift() ?? ('granted' as AltitudeRequestOutcome),
    label: null
  }))
  const session = {
    getStatus: () => ({ state: 'connected' as const, lastError: null }),
    getState: (): BeyondAtcState => EMPTY_STATE,
    getTranscript: () => opts.transcript ?? [],
    setAction: vi.fn(),
    on: vi.fn(),
    off: vi.fn()
  }
  const logs: string[] = []
  const controller = new StepClimbController({
    getSession: () => session,
    getActive: () => ({ flightId: 7, phase: opts.phase ?? 'cruise' }),
    getOfpJson: () => ofpJson(),
    request,
    now: () => now,
    log: (m) => logs.push(m)
  })
  const statuses: BeyondAtcStepClimbStatus[] = []
  controller.on('status', (s) => statuses.push(s))
  return {
    controller,
    request,
    statuses,
    logs,
    advance: (ms: number) => {
      now += ms
    }
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('extractStepPlan', () => {
  it("places each SimBrief step on its navlog fix, converting China's metric level", () => {
    const { steps } = extractStepPlan(ofpJson())
    // EGLL has no navlog fix here — skipped rather than guessed.
    expect(steps.map((s) => s.ident)).toEqual(['DENAK', 'KAMUD'])
    expect(steps[0]).toMatchObject({ lat: 45, lon: 30, altitudeFt: 35000 })
    expect(steps[1]!.altitudeFt).toBeCloseTo(11300 / FT, 0)
  })

  it('degrades to no steps for a free flight or a malformed OFP', () => {
    expect(extractStepPlan(null)).toEqual({ fixes: [], steps: [] })
    expect(extractStepPlan('{not json')).toEqual({ fixes: [], steps: [] })
  })

  it('drops down steps — over China the levels swap with direction (Callum, 2026-10-01)', () => {
    // 11,300 m → 10,700 m (down) → 11,300 m (back, not higher than before) → 11,900 m.
    const fix = (ident: string, lon: string): Record<string, string> => ({ ident, altitude_feet: '37000', distance: '0', pos_lat: '30.0', pos_long: lon })
    const { steps } = extractStepPlan(
      ofpJson('AAAAA/1130/BBBBB/1070/CCCCC/1130/DDDDD/1190', [fix('AAAAA', '100'), fix('BBBBB', '105'), fix('CCCCC', '110'), fix('DDDDD', '115')])
    )
    expect(steps.map((s) => s.ident)).toEqual(['AAAAA', 'DDDDD'])
    expect(steps[1]!.altitudeFt).toBeCloseTo(11900 / FT, 0)
  })
})

describe('clearedLevelFromTranscript', () => {
  it("takes ATC's latest altitude instruction, in every real phrasing", () => {
    const atc = (text: string, ts: number): BeyondAtcTranscriptEntry => ({ speaker: 'atc', text, ts })
    expect(
      clearedLevelFromTranscript([
        atc('Hongkong Shuttle 250, Hong Kong Delivery, cleared to Phoenix airport via PECA1D departure, runway 25C, climb via SID to FL140, squawk 6140.', 1),
        atc('Hongkong Shuttle 250, Hong Kong Radar, identified, climb FL380.', 2),
        { speaker: 'player', text: 'Climb FL380, Hongkong Shuttle 250.', ts: 3 }
      ])
    ).toBe(38000)
    expect(clearedLevelFromTranscript([atc('Hongkong Shuttle 250, roger, new cruise altitude FL360.', 1)])).toBe(36000)
    expect(clearedLevelFromTranscript([atc('Hongkong Shuttle 250, descend to 3,000m, QNH 1012.', 1)])).toBeCloseTo(3000 / FT, 0)
    expect(clearedLevelFromTranscript([atc('Hongkong Shuttle 250, contact Hong Kong Tower 118.2.', 1)])).toBeNull()
  })
})

describe('StepClimbController', () => {
  it('does nothing while switched off', () => {
    const { controller, request } = setup()
    controller.onTelemetry(telemetry({ latitude: 45, longitude: 29.95 }))
    expect(request).not.toHaveBeenCalled()
  })

  it('shows the next SimBrief step, and asks for it under a minute out (not before)', async () => {
    const { controller, request, statuses } = setup()
    controller.setEnabled(true)

    controller.onTelemetry(telemetry()) // ~60 nm out
    expect(request).not.toHaveBeenCalled()
    expect(statuses.at(-1)?.nextStep).toMatchObject({ ident: 'DENAK', altitudeFt: 35000 })

    controller.onTelemetry(telemetry({ longitude: 29.9 })) // ~4 nm out at ~470 kt
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]![1]).toBe(35000)
    await flush()
    expect(statuses.at(-1)?.last).toMatchObject({ altitudeFt: 35000, outcome: 'granted', reason: 'simbrief' })
  })

  it("asks for the FCU level once the aircraft's own step climb sets it and it settles", () => {
    const { controller, request, advance } = setup()
    controller.setEnabled(true)

    controller.onTelemetry(telemetry({ apSelectedAltitudeM: 37000 * FT }))
    advance(5_000)
    controller.onTelemetry(telemetry({ apSelectedAltitudeM: 37000 * FT }))
    expect(request).not.toHaveBeenCalled() // still settling

    advance(6_000)
    controller.onTelemetry(telemetry({ apSelectedAltitudeM: 37000 * FT }))
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]![1]).toBe(37000)
  })

  it('ignores a knob sweep that never settles, and never asks for a descent', () => {
    const { controller, request, advance } = setup()
    controller.setEnabled(true)
    for (const ft of [34000, 35000, 36000, 37000, 38000]) {
      controller.onTelemetry(telemetry({ apSelectedAltitudeM: ft * FT }))
      advance(1_000)
    }
    expect(request).not.toHaveBeenCalled()

    const low = setup()
    low.controller.setEnabled(true)
    low.controller.onTelemetry(telemetry({ apSelectedAltitudeM: 31000 * FT }))
    low.advance(15_000)
    low.controller.onTelemetry(telemetry({ apSelectedAltitudeM: 31000 * FT }))
    expect(low.request).not.toHaveBeenCalled()
  })

  it('retries once after two minutes, then drops the level and moves on', async () => {
    const { controller, request, statuses, advance } = setup({ outcomes: ['notOffered', 'noAnswer', 'granted'] })
    controller.setEnabled(true)
    const near = telemetry({ longitude: 29.9 })

    controller.onTelemetry(near)
    await flush()
    expect(request).toHaveBeenCalledTimes(1)

    advance(60_000)
    controller.onTelemetry(near)
    expect(request).toHaveBeenCalledTimes(1) // too soon to retry

    advance(61_000)
    controller.onTelemetry(near)
    await flush()
    expect(request).toHaveBeenCalledTimes(2)
    expect(statuses.at(-1)?.last).toMatchObject({ altitudeFt: 35000, attempt: 2, dropped: true })

    advance(300_000)
    controller.onTelemetry(near)
    expect(request).toHaveBeenCalledTimes(2) // FL350 dropped for good
    expect(statuses.at(-1)?.nextStep?.ident).toBe('KAMUD') // moved on to the next step
  })

  it('moves past a step point already behind the aircraft instead of waiting on it forever', () => {
    const { controller, request, statuses } = setup()
    controller.setEnabled(true)
    // Past DENAK (switched on late / the FL350 step not taken), now nearest MIDPT, still FL330.
    controller.onTelemetry(telemetry({ latitude: 42.2, longitude: 49 }))
    expect(statuses.at(-1)?.nextStep?.ident).toBe('KAMUD')
    expect(request).not.toHaveBeenCalled()
  })

  it('writes a decision trail to the log, so an overnight flight can be read back', async () => {
    const { controller, logs, advance } = setup()
    controller.setEnabled(true)
    controller.onTelemetry(telemetry({ apSelectedAltitudeM: 33000 * FT }))
    advance(1_000)
    controller.onTelemetry(telemetry({ longitude: 29.9, apSelectedAltitudeM: 33000 * FT }))
    await flush()

    expect(logs).toEqual([
      '[step-climb] enabled',
      '[step-climb] flight 7: 3 route fixes, steps DENAK@35000 KAMUD@37073',
      '[step-climb] FCU altitude 33000 ft (phase cruise)',
      '[step-climb] cleared level 33000 ft (no ATC level, using altitude)',
      expect.stringMatching(/^\[step-climb\] next step DENAK@35000 \(\d+ nm\)$/),
      '[step-climb] requesting 35000 ft (trigger simbrief, attempt 1)',
      '[step-climb] request 35000 ft: granted'
    ])
  })

  it('stays quiet outside cruise, and when the level is already cleared', () => {
    const climbing = setup({ phase: 'climb' })
    climbing.controller.setEnabled(true)
    climbing.controller.onTelemetry(telemetry({ longitude: 29.9 }))
    expect(climbing.request).not.toHaveBeenCalled()

    const cleared = setup({ transcript: [{ speaker: 'atc', text: 'Hongkong Shuttle 250, climb FL350.', ts: 1 }] })
    cleared.controller.setEnabled(true)
    cleared.controller.onTelemetry(telemetry({ longitude: 29.9 }))
    expect(cleared.request).not.toHaveBeenCalled()
  })
})

describe('distanceNm', () => {
  it('is a real great-circle distance', () => {
    // One degree of latitude ≈ 60 nm.
    expect(distanceNm(45, 30, 46, 30)).toBeCloseTo(60, 0)
  })
})
