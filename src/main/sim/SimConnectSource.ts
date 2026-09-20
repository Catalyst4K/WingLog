import type { SimTelemetry } from '@shared/ipc'

/**
 * A near-contact touchdown severity reading from SimConnectService's second, high-rate
 * SimConnect stream (v1.2 Part 1, flightdeck-backend's docs/plans/landing-scoring-v2.md
 * Part 3) — the peak (max-magnitude) vertical speed in the last second before ground
 * contact, sampled far more densely than the primary 1 Hz stream. Real flights
 * (docs/simconnect-notes.md, 2026-09-20) found the 1 Hz "previous tick" value can miss true
 * touchdown severity by 55-87% in either direction depending on where the 1-second grid
 * happens to fall relative to each landing's own flare — this is the fix. Same sign
 * convention as SimTelemetry.verticalSpeedMs (negative = descending).
 */
export interface TouchdownSeverity {
  verticalSpeedMs: number
}

/**
 * The subset of SimConnectService's surface TrackingController actually depends on —
 * satisfied structurally by both SimConnectService and ReplaySimConnectService, so
 * TrackingController's constructor needs no concrete-class cast to accept either.
 * flightdeck-backend's docs/plans/flight-replay-harness.md Phase 3 (the main/index.ts
 * injection seam): the interface extraction that lets an e2e/test context hand
 * TrackingController a replay double in place of a live sim connection.
 */
export interface SimConnectSource {
  on(event: 'telemetry', listener: (telemetry: SimTelemetry) => void): this
  on(event: 'paused', listener: (paused: boolean) => void): this
  /** Fires once per touchdown, from the high-rate stream's own (more precise) ground-
   *  contact detection — arrives at essentially the same real-world moment as, or fractionally
   *  before, the primary stream's own onGround edge that drives detectTouchdown. Never fires
   *  for ReplaySimConnectService (recorded fixtures are 1 Hz only) — TrackingController falls
   *  back to previousTelemetry in that case, same as before this existed. */
  on(event: 'touchdownSeverity', listener: (result: TouchdownSeverity) => void): this
  getLastTelemetry(): SimTelemetry | undefined
}
