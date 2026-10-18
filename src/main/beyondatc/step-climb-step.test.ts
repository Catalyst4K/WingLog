import { describe, expect, it } from 'vitest'
import type { ActiveTracking, SimTelemetry } from '@shared/ipc'
import { extractStepPlan } from './step-climb-plan'
import {
  INITIAL_STEP_CLIMB_STATE,
  finishRequest,
  setStepClimbEnabled,
  settleRequest,
  stepClimbStatus,
  tickStepClimb,
  type StepClimbState,
  type StepClimbTick
} from './step-climb-step'

const FT = 0.3048

// A route with a planned step at DENAK (FL330 -> FL350) and SimBrief's TOD marker near the end.
const FIXES = [
  { ident: 'DENAK', altitude_feet: '35000', distance: '900', pos_lat: '45.0', pos_long: '30.0' },
  { ident: 'MIDPT', altitude_feet: '35000', distance: '1900', pos_lat: '42.0', pos_long: '50.0' },
  { ident: 'KAMUD', altitude_feet: '37000', distance: '3000', pos_lat: '40.0', pos_long: '75.0' },
  { ident: 'TOD', altitude_feet: '37000', distance: '400', pos_lat: '38.0', pos_long: '82.0' },
  { ident: 'VHHH', altitude_feet: '100', distance: '120', pos_lat: '37.0', pos_long: '84.0' }
]
const OFP = JSON.stringify({
  fetch: { status: 'Success' },
  params: { request_id: '1', units: 'kgs' },
  origin: { icao_code: 'EGLL' },
  destination: { icao_code: 'VHHH' },
  alternate: { icao_code: 'VMMC' },
  general: {
    icao_airline: 'BAW',
    flight_number: '31',
    route: 'DCT',
    initial_altitude: '33000',
    stepclimb_string: 'EGLL/0330/DENAK/0350'
  },
  aircraft: { icaocode: 'A35K', reg: 'G-XWBS', internal_id: 'A35K', is_custom: '0' },
  weights: { pax_count: '1', cargo: '0', est_zfw: '1', est_tow: '1', est_ldw: '1' },
  fuel: { plan_ramp: '1' },
  times: { sched_out: '1787860800', sched_in: '1787898900' },
  navlog: { fix: FIXES }
})

/** Cruising at FL330, 60 nm short of DENAK at ~470 kt. */
function telemetry(overrides: Partial<SimTelemetry> = {}): SimTelemetry {
  return {
    latitude: 45.0,
    longitude: 28.6,
    altitudeM: 33000 * FT,
    pressureAltitudeM: 33000 * FT,
    verticalSpeedMs: 0,
    groundSpeedMs: 242,
    apSelectedAltitudeM: 33000 * FT,
    ...overrides
  } as SimTelemetry
}

const CRUISE: ActiveTracking = { flightId: 7, phase: 'cruise' }

function tick(overrides: Partial<StepClimbTick> = {}): StepClimbTick {
  return {
    t: telemetry(),
    now: 1_000_000,
    active: CRUISE,
    boxLevelFt: null,
    isConnected: () => true,
    getOfpJson: () => OFP,
    ...overrides
  }
}

const enabled: StepClimbState = setStepClimbEnabled(INITIAL_STEP_CLIMB_STATE, true).state

describe('tickStepClimb', () => {
  it('does nothing while switched off', () => {
    const result = tickStepClimb(INITIAL_STEP_CLIMB_STATE, tick())
    expect(result.state).toBe(INITIAL_STEP_CLIMB_STATE)
    expect(result.logs).toEqual([])
    expect(result.fire).toBeNull()
  })

  it('forgets the flight and the next step when nothing is being tracked', () => {
    const tracking = tickStepClimb(enabled, tick()).state
    expect(tracking.flightId).toBe(7)
    const idle = tickStepClimb(tracking, tick({ active: undefined }))
    expect(idle.state.flightId).toBeNull()
    expect(idle.state.nextStep).toBeNull()
    expect(idle.fire).toBeNull()
  })

  it('loads the flight plan once and says what it found', () => {
    const first = tickStepClimb(enabled, tick())
    expect(first.logs[0]).toBe('flight 7: 5 route fixes, steps DENAK@35000')
    expect(first.state.plan.todOrder).toBe(3)
    const second = tickStepClimb(
      first.state,
      tick({
        getOfpJson: () => {
          throw new Error('read again')
        }
      })
    )
    expect(second.logs.some((line) => line.startsWith('flight '))).toBe(false)
  })

  it('asks for the planned step once the aircraft is within a minute of it', () => {
    const far = tickStepClimb(enabled, tick({ t: telemetry({ longitude: 20 }) }))
    expect(far.fire).toBeNull()
    const near = tickStepClimb(enabled, tick({ t: telemetry({ longitude: 29.9 }) }))
    expect(near.fire).toEqual({ altitudeFt: 35000, reason: 'simbrief' })
    expect(near.state.inFlight).toBe(35000)
    expect(near.state.attempts[35000]).toEqual({ count: 1, lastAt: 1_000_000 })
    expect(near.logs.at(-1)).toBe('requesting 35000 ft (trigger simbrief, attempt 1)')
  })

  it('asks for nothing outside cruise, while a request is out, or when BeyondATC is not connected', () => {
    const near = { t: telemetry({ longitude: 29.9 }) }
    expect(tickStepClimb(enabled, tick({ ...near, active: { flightId: 7, phase: 'climb' } })).fire).toBeNull()
    expect(tickStepClimb(enabled, tick({ ...near, isConnected: () => false })).fire).toBeNull()
    const firing = tickStepClimb(enabled, tick(near))
    expect(tickStepClimb(firing.state, tick({ ...near, now: 1_005_000 })).fire).toBeNull()
  })

  it('waits for a sustained climb before asking for a level the FCU was dialled to', () => {
    // FCU on FL340 (not the planned FL350), 20 nm out of range of the planned step.
    const base = { t: telemetry({ longitude: 20, apSelectedAltitudeM: 34000 * FT }) }
    let state = tickStepClimb(enabled, tick(base)).state
    const waiting = tickStepClimb(state, tick({ ...base, now: 1_011_000 }))
    expect(waiting.fire).toBeNull()
    expect(waiting.state.waitingForClimb).toBe(34000)
    const climbing = { t: telemetry({ ...base.t, verticalSpeedMs: 5 }) }
    state = tickStepClimb(waiting.state, tick({ ...climbing, now: 1_012_000 })).state
    const asked = tickStepClimb(state, tick({ ...climbing, now: 1_023_000 }))
    expect(asked.fire).toEqual({ altitudeFt: 34000, reason: 'fcu' })
  })

  it('asks for no more levels after the top of descent', () => {
    const late = tickStepClimb(enabled, tick({ t: telemetry({ latitude: 38, longitude: 82.5 }) }))
    expect(late.state.pastTopOfDescent).toBe(true)
    expect(late.logs).toContain('past top of descent: no more requests this flight')
    expect(late.fire).toBeNull()
  })

  it('does not change the state it was given', () => {
    const before = structuredClone(enabled)
    tickStepClimb(enabled, tick({ t: telemetry({ longitude: 29.9 }) }))
    expect(enabled).toEqual(before)
  })
})

describe('settleRequest and finishRequest', () => {
  function firedState(): StepClimbState {
    return tickStepClimb(enabled, tick({ t: telemetry({ longitude: 29.9 }) })).state
  }

  it('forgets the attempts for a granted level and notes the result', () => {
    const result = settleRequest(firedState(), {
      altitudeFt: 35000,
      reason: 'simbrief',
      outcome: 'granted',
      attempt: 1
    })
    expect(result.state.attempts[35000]).toBeUndefined()
    expect(result.state.last).toEqual({
      altitudeFt: 35000,
      outcome: 'granted',
      attempt: 1,
      reason: 'simbrief',
      dropped: false
    })
    expect(result.logs).toEqual(['request 35000 ft: granted'])
  })

  it('keeps a refused level for a retry, then drops it after the second attempt', () => {
    const first = settleRequest(firedState(), {
      altitudeFt: 35000,
      reason: 'simbrief',
      outcome: 'notOffered',
      attempt: 1
    })
    expect(first.state.dropped).toEqual([])
    expect(first.state.attempts[35000]?.count).toBe(1)
    const second = settleRequest(first.state, {
      altitudeFt: 35000,
      reason: 'simbrief',
      outcome: 'notOffered',
      attempt: 2
    })
    expect(second.state.dropped).toEqual([35000])
    expect(second.logs).toEqual(['request 35000 ft: notOffered, dropped'])
    expect(second.state.last?.dropped).toBe(true)
  })

  it('shows the request as pending until it finishes', () => {
    const fired = firedState()
    expect(stepClimbStatus(fired).pendingAltitudeFt).toBe(35000)
    expect(stepClimbStatus(finishRequest(fired)).pendingAltitudeFt).toBeNull()
  })
})

describe('setStepClimbEnabled', () => {
  it('logs only a change, and forgets the FCU level and the next step when switched off', () => {
    const on = setStepClimbEnabled(INITIAL_STEP_CLIMB_STATE, true)
    expect(on.logs).toEqual(['enabled'])
    expect(setStepClimbEnabled(on.state, true).logs).toEqual([])
    const tracking = tickStepClimb(on.state, tick({ t: telemetry({ longitude: 20 }) })).state
    expect(tracking.fcu).not.toBeNull()
    const off = setStepClimbEnabled(tracking, false)
    expect(off.logs).toEqual(['disabled'])
    expect(off.state).toMatchObject({ enabled: false, fcu: null, nextStep: null, waitingForClimb: null })
  })
})

describe('extractStepPlan', () => {
  it('is re-exported with the plan module and degrades to no steps for no OFP', () => {
    expect(extractStepPlan(null).steps).toEqual([])
  })
})
