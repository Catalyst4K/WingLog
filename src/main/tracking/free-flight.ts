import type { FlightPhase, SimTelemetry } from '@shared/ipc'
import { LEVEL_VS_MS, MOVING_MS } from './FlightRecorder'

/**
 * Seeds FlightRecorder's `resume` phase for a flight that starts being tracked mid-session
 * rather than from a parked departure (free-flight-tracking.md's "Tracking, including from
 * mid-air") — without a seed, `advancePhase`'s 'preflight' case only ever leaves on
 * `t.onGround`, so a recorder started already airborne would sit stuck there forever, the
 * same failure crash-recovery's own `resume` parameter exists to avoid.
 *
 * Reuses FlightRecorder's own MOVING_MS/LEVEL_VS_MS thresholds rather than inventing
 * seeding-only numbers, so a flight seeded here behaves identically from this point on to
 * one that reached the same state by flying through it.
 */
export function seedPhaseFromTelemetry(telemetry: SimTelemetry): FlightPhase {
  if (telemetry.onGround) {
    return telemetry.groundSpeedMs > MOVING_MS ? 'taxi' : 'preflight'
  }
  if (telemetry.verticalSpeedMs > LEVEL_VS_MS) return 'climb'
  if (telemetry.verticalSpeedMs < -LEVEL_VS_MS) return 'descent'
  return 'cruise'
}
