import { describe, expect, it } from 'vitest'
import type { SimTelemetry } from '@shared/ipc'
import { initialTouchdownState, touchdownStep } from './touchdown-step'

/** Parked at a gate: on the ground, stopped. */
function telemetry(overrides: Partial<SimTelemetry> = {}): SimTelemetry {
  return {
    latitude: 18.3074,
    longitude: 109.4034,
    altitudeM: 27.4,
    pressureAltitudeM: 0,
    altitudeAglM: 2.72,
    verticalSpeedMs: 0,
    indicatedAirspeedMs: 0,
    machSpeed: 0,
    groundSpeedMs: 0,
    headingTrueDeg: 352,
    pitchDeg: 0.1,
    bankDeg: 0,
    onGround: true,
    gForce: 1,
    fuelTotalKg: 10186,
    windSpeedMs: 1.6,
    windDirectionDeg: 90,
    engineCombustion1: false,
    parkingBrakeOn: true,
    simRate: 1,
    slewActive: false,
    ...overrides
  } as SimTelemetry
}

/** Steps the rule through the ticks and returns the indexes that were touchdowns. */
function touchdowns(ticks: Partial<SimTelemetry>[]): number[] {
  const state = initialTouchdownState()
  return ticks.flatMap((t, i) => (touchdownStep(state, telemetry(t)) ? [i] : []))
}

const flying = { onGround: false, groundSpeedMs: 70, altitudeAglM: 40, verticalSpeedMs: -3.5 }
const landed = { onGround: true, groundSpeedMs: 64, verticalSpeedMs: -0.9 }

describe('touchdownStep', () => {
  it('finds the touchdown after a real flight', () => {
    expect(touchdowns([{}, flying, flying, flying, flying, landed, landed])).toEqual([5])
  })

  it('does not treat a flight that starts on the ground as a touchdown', () => {
    expect(touchdowns([landed, landed])).toEqual([])
  })

  it('ignores a rollout bounce shorter than three airborne samples', () => {
    const bounce = { ...flying, groundSpeedMs: 58, altitudeAglM: 3 }
    expect(touchdowns([flying, flying, flying, landed, bounce, bounce, landed])).toEqual([3])
  })

  it('ignores the sim loading the aircraft in at the gate, stationary and "airborne" for 16 s', () => {
    // Flight 253 at ZJSY, from its capture: on-ground false at the spawn height with zero speed, g and vertical speed.
    const loading = { onGround: false, altitudeAglM: 3.18, gForce: 0 }
    expect(touchdowns([{}, ...Array(16).fill(loading), { altitudeAglM: 3.18 }])).toEqual([])
  })

  it('ignores the aircraft being set back down at the gate, even with each tick arriving four times', () => {
    const setDown = { onGround: false, altitudeAglM: 3.18, groundSpeedMs: 0.004, gForce: 0.53 }
    expect(touchdowns([{}, setDown, setDown, setDown, setDown, { altitudeAglM: 2.78 }])).toEqual([])
  })

  it('counts each touchdown of a touch-and-go', () => {
    expect(touchdowns([flying, flying, flying, landed, flying, flying, flying, landed])).toEqual([3, 7])
  })
})
