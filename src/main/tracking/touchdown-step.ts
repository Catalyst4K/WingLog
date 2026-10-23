/**
 * The one rule for "this tick is a touchdown", used by TrackingController to log landings and by the flight replay tools
 * to find the same touchdown in a capture. A touchdown is the raw on-ground false -> true edge, independent of the phase
 * machine, whose descent -> landing edge has holes for circuit flying (winglog-backend docs/plans/multiple-landings.md).
 */
import type { SimTelemetry } from '@shared/ipc'
import { MOVING_MS } from './flight-phase-step'

// A touchdown only counts as a *new* one after this many consecutive airborne samples since the last ground contact. At the
// 1 Hz telemetry rate, a handful of seconds genuinely airborne rules out a rollout bounce (gear compression briefly reporting
// on-ground -> off -> on again) without missing a real short circuit hop.
export const MIN_AIRBORNE_SAMPLES_FOR_NEW_TOUCHDOWN = 3

/** What the rule remembers between ticks. */
export interface TouchdownState {
  /** Undefined until the first tick, so a flight that starts on the ground can't read as an edge. */
  wasOnGround: boolean | undefined
  /** Consecutive airborne samples since the last ground contact. */
  airborneStreak: number
  /** Whether the aircraft moved at all while off the ground. The sim loading an aircraft in at the gate reports "airborne"
   *  for seconds while it sits still (flight 253 logged two landings at ZJSY's gate that way); nothing that flew stays put. */
  airborneMoved: boolean
}

/**
 * A fresh state, for the start of a flight.
 *
 * @returns The state before any tick.
 */
export function initialTouchdownState(): TouchdownState {
  return { wasOnGround: undefined, airborneStreak: 0, airborneMoved: false }
}

/**
 * Steps the rule by one tick. The state is read before it's updated, so the check sees the airborne stretch that came
 * *before* this ground contact.
 *
 * @param state The rule's state, updated in place.
 * @param telemetry This tick.
 * @returns Whether this tick is a touchdown.
 */
export function touchdownStep(state: TouchdownState, telemetry: SimTelemetry): boolean {
  const isTouchdown =
    state.wasOnGround === false &&
    telemetry.onGround &&
    state.airborneStreak >= MIN_AIRBORNE_SAMPLES_FOR_NEW_TOUCHDOWN &&
    state.airborneMoved
  state.wasOnGround = telemetry.onGround
  state.airborneStreak = telemetry.onGround ? 0 : state.airborneStreak + 1
  state.airborneMoved = !telemetry.onGround && (state.airborneMoved || telemetry.groundSpeedMs > MOVING_MS)
  return isTouchdown
}
