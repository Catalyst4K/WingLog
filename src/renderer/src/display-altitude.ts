import type { FlightPhase } from '@shared/ipc'
import type { TransitionAltitudes } from './route'
import { mToFt } from './units'

/**
 * Picks pressure altitude above the transition, true altitude below it — what a correctly
 * set altimeter actually reads in each regime (flightdeck-backend's docs/plans/
 * logbook-detail-improvements.md, Phase 3): flight levels in cruise, matching the PFD
 * exactly, and roughly field elevation near the airports, where true altitude ≈ QNH
 * altitude. Both inputs are computed by the sim, so neither depends on how a given
 * aircraft implements its altimeter — the same reason PLANE ALTITUDE replaced INDICATED
 * ALTITUDE for storage in the first place (docs/decisions.md, 2026-09-05).
 *
 * Whether a point is "above" or "below" the transition is read off its own recorded flight
 * phase rather than computed from the flight's actual highest altitude: the choice only
 * matters below about FL180 (climb/taxi/etc. vs. descent/landing), which real phases
 * already distinguish, and phase is already recorded on every point/telemetry tick — no
 * extra bookkeeping needed. `cruise` is bucketed with the descent-side phases; harmless in
 * practice, since a real cruise altitude sits far above either transition figure regardless
 * of which one gets picked.
 */
const CLIMB_SIDE_PHASES: ReadonlySet<FlightPhase> = new Set(['preflight', 'pushback', 'taxi', 'takeoff', 'climb'])

/** Falls back to this when there's no OFP to read a real transition altitude/level from
 *  (an ad hoc Track-started flight, or one predating this feature) — see the plan's own
 *  "flights with no OFP fall back to 18,000 ft" note. Below that, true altitude is close to
 *  what a GA pilot's QNH altimeter shows; a jet's cruise is comfortably above it. */
const DEFAULT_TRANSITION_FT = 18_000

export interface DisplayAltitudeInput {
  altitudeM: number
  /** Null for a point recorded before this column existed — always shows true altitude in
   *  that case, see DisplayAltitudeResult.label. */
  pressureAltitudeM: number | null
  phase: FlightPhase
}

export interface DisplayAltitudeResult {
  valueFt: number
  /** 'True altitude' only when there's no pressure-altitude reading to switch to (an older
   *  flight recorded before this column existed) — labelled so the mismatch this whole
   *  plan exists to fix isn't re-reported as a new bug against old data. */
  label: 'Altitude' | 'True altitude'
}

export function displayAltitude(input: DisplayAltitudeInput, transition: TransitionAltitudes | null): DisplayAltitudeResult {
  const trueAltFt = mToFt(input.altitudeM)
  if (input.pressureAltitudeM == null) {
    return { valueFt: trueAltFt, label: 'True altitude' }
  }
  const thresholdFt = transition
    ? CLIMB_SIDE_PHASES.has(input.phase)
      ? transition.transAltFt
      : transition.transLevelFt
    : DEFAULT_TRANSITION_FT
  // Compared against true altitude, not pressure altitude — true altitude is what's always
  // available and is already a close proxy for QNH altitude near the ground, where the
  // comparison actually matters (see the module comment above).
  const valueFt = trueAltFt > thresholdFt ? mToFt(input.pressureAltitudeM) : trueAltFt
  return { valueFt, label: 'Altitude' }
}
