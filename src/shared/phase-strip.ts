/**
 * Which taxi the phase strip shows. The phase machine has one 'taxi' phase; the strip tells "Taxi out" from "Taxi in"
 * (winglog-backend's docs/plans/phase-lights-taxi-in.md).
 */
import type { FlightPhase } from '@shared/ipc'

/**
 * Whether a flight's taxi is the one after a landing.
 *
 * Reads back from the newest point to the latest touchdown or takeoff: a touchdown later than the takeoff is "Taxi in", so a circuit
 * (touch-and-go, then up again) follows its last leg. A flight that has not taken off yet is "Taxi out".
 *
 * @param points The flight's track points in time order (only each point's phase is read).
 * @returns True when the latest landing is later than the latest takeoff.
 */
export function isPastLanding(points: ReadonlyArray<{ phase: FlightPhase }>): boolean {
  for (let i = points.length - 1; i >= 0; i--) {
    const phase = points[i].phase
    if (phase === 'landing') return true
    if (phase === 'takeoff') return false
  }
  return false
}
