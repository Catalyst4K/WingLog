import { describe, expect, it } from 'vitest'
import type { SimTelemetry } from '@shared/ipc'
import {
  INITIAL_PHASE_STATE,
  buildTrackPoint,
  stepPhase,
  type PhaseSettings,
  type PhaseState
} from './flight-phase-step'

/** On the ground, stopped, engines off. */
function telemetry(overrides: Partial<SimTelemetry> = {}): SimTelemetry {
  return {
    latitude: 51.47,
    longitude: -0.45,
    altitudeM: 25,
    pressureAltitudeM: 25,
    altitudeAglM: 0,
    verticalSpeedMs: 0,
    indicatedAirspeedMs: 0,
    machSpeed: 0,
    groundSpeedMs: 0,
    headingTrueDeg: 270,
    pitchDeg: 0,
    bankDeg: 0,
    onGround: true,
    gForce: 1,
    fuelTotalKg: 5000,
    windSpeedMs: 0,
    windDirectionDeg: 0,
    engineCombustion1: false,
    parkingBrakeOn: false,
    simRate: 1,
    slewActive: false,
    ...overrides
  } as SimTelemetry
}

const SETTINGS: PhaseSettings = { paused: false, autoShutdown: true, runwayCheck: () => null }
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0)

/** Runs ticks one second apart, returning the state after each. */
function run(from: PhaseState, ticks: Partial<SimTelemetry>[], settings: PhaseSettings = SETTINGS): PhaseState[] {
  const states: PhaseState[] = []
  let state = from
  for (const [i, tick] of ticks.entries()) {
    state = stepPhase(state, telemetry(tick), T0 + i * 1000, settings).state
    states.push(state)
  }
  return states
}

describe('stepPhase', () => {
  it('goes from preflight to pushback on movement or an engine running, and to taxi at taxi speed', () => {
    const [moved] = run(INITIAL_PHASE_STATE, [{ groundSpeedMs: 1 }])
    expect(moved?.phase).toBe('pushback')
    const [engine] = run(INITIAL_PHASE_STATE, [{ engineCombustion1: true }])
    expect(engine?.phase).toBe('pushback')
    const [taxi] = run({ ...INITIAL_PHASE_STATE, phase: 'pushback' }, [{ groundSpeedMs: 3 }])
    expect(taxi?.phase).toBe('taxi')
  })

  it('takes a fast taxi for the takeoff roll only where a runway is, or none is known', () => {
    const taxi: PhaseState = { ...INITIAL_PHASE_STATE, phase: 'taxi' }
    const fast = [{ groundSpeedMs: 25 }]
    expect(run(taxi, fast)[0]?.phase).toBe('takeoff')
    expect(run(taxi, fast, { ...SETTINGS, runwayCheck: () => true })[0]?.phase).toBe('takeoff')
    expect(run(taxi, fast, { ...SETTINGS, runwayCheck: () => false })[0]?.phase).toBe('taxi')
  })

  it('does not take a rollout speed blip after landing for a second takeoff roll', () => {
    const landed: PhaseState = { ...INITIAL_PHASE_STATE, phase: 'taxi', hasLanded: true }
    expect(run(landed, [{ groundSpeedMs: 25 }])[0]?.phase).toBe('taxi')
  })

  it('leaves climb for cruise after ten level samples, and cruise for descent after five descending ones', () => {
    const level = Array.from({ length: 10 }, () => ({ onGround: false, verticalSpeedMs: 0 }))
    const climb: PhaseState = { ...INITIAL_PHASE_STATE, phase: 'climb' }
    expect(run(climb, level.slice(0, 9)).at(-1)?.phase).toBe('climb')
    expect(run(climb, level).at(-1)?.phase).toBe('cruise')
    const down = Array.from({ length: 5 }, () => ({ onGround: false, verticalSpeedMs: -3 }))
    const cruise: PhaseState = { ...INITIAL_PHASE_STATE, phase: 'cruise' }
    expect(run(cruise, down.slice(0, 4)).at(-1)?.phase).toBe('cruise')
    expect(run(cruise, down).at(-1)?.phase).toBe('descent')
  })

  it('lands on the first tick on the ground in descent, and notes the flight has landed', () => {
    const [landed] = run({ ...INITIAL_PHASE_STATE, phase: 'descent' }, [{ onGround: true, groundSpeedMs: 70 }])
    expect(landed).toMatchObject({ phase: 'landing', hasLanded: true })
  })

  it('goes back to climb after three airborne ticks on the rollout, not one', () => {
    const rollout: PhaseState = { ...INITIAL_PHASE_STATE, phase: 'landing', hasLanded: true }
    const air = { onGround: false, groundSpeedMs: 60 }
    const [one, two, three] = run(rollout, [air, air, air])
    expect([one?.phase, two?.phase, three?.phase]).toEqual(['landing', 'landing', 'climb'])
    const [bounce, down] = run(rollout, [air, { onGround: true, groundSpeedMs: 40 }])
    expect([bounce?.phase, down?.phase]).toEqual(['landing', 'landing'])
  })

  it('shuts down when parked after landing, and only with auto-shutdown on', () => {
    const parked = [{ groundSpeedMs: 0, parkingBrakeOn: true, engineCombustion1: false }]
    const landedTaxi: PhaseState = { ...INITIAL_PHASE_STATE, phase: 'taxi', hasLanded: true }
    expect(run(landedTaxi, parked)[0]?.phase).toBe('shutdown')
    expect(run(landedTaxi, parked, { ...SETTINGS, autoShutdown: false })[0]?.phase).toBe('taxi')
    expect(run({ ...INITIAL_PHASE_STATE }, parked)[0]?.phase).toBe('preflight')
  })

  it('freezes while paused or slewing: no change, no point', () => {
    const state: PhaseState = { ...INITIAL_PHASE_STATE, phase: 'taxi' }
    const paused = stepPhase(state, telemetry({ groundSpeedMs: 25 }), T0, { ...SETTINGS, paused: true })
    expect(paused).toEqual({ state, record: false })
    const slewing = stepPhase(state, telemetry({ groundSpeedMs: 25, slewActive: true }), T0, SETTINGS)
    expect(slewing).toEqual({ state, record: false })
  })

  it('records the first tick, then one per second on the ground, two in climb, five in cruise', () => {
    const records = (phase: PhaseState['phase'], gapS: number): boolean[] => {
      let state: PhaseState = { ...INITIAL_PHASE_STATE, phase }
      const out: boolean[] = []
      for (const at of [0, gapS, gapS * 2]) {
        const step = stepPhase(state, telemetry({ onGround: phase === 'taxi', groundSpeedMs: 5, verticalSpeedMs: phase === 'climb' ? 5 : 0 }), T0 + at * 1000, SETTINGS)
        state = step.state
        out.push(step.record)
      }
      return out
    }
    expect(records('taxi', 1)).toEqual([true, true, true])
    expect(records('climb', 1)).toEqual([true, false, true])
    expect(records('cruise', 2)).toEqual([true, false, false])
    expect(records('cruise', 5)).toEqual([true, true, true])
  })

  it('does not change the state it was given', () => {
    const before = structuredClone(INITIAL_PHASE_STATE)
    stepPhase(INITIAL_PHASE_STATE, telemetry({ groundSpeedMs: 3, engineCombustion1: true }), T0, SETTINGS)
    expect(INITIAL_PHASE_STATE).toEqual(before)
  })
})

describe('buildTrackPoint', () => {
  it('stamps the flight, the phase after the tick, the resume segment and the time', () => {
    const state: PhaseState = { ...INITIAL_PHASE_STATE, phase: 'cruise', resumeSegment: 2 }
    const point = buildTrackPoint(42, state, telemetry({ latitude: 40, fuelTotalKg: 4321 }), new Date(T0))
    expect(point).toMatchObject({
      flightId: 42,
      phase: 'cruise',
      resumeSegment: 2,
      latitude: 40,
      fuelKg: 4321,
      tsUtc: '2026-10-01T12:00:00.000Z',
      excludedReason: null
    })
  })
})
