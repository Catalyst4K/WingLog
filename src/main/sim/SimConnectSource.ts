import type { SimTelemetry } from '@shared/ipc'

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
  getLastTelemetry(): SimTelemetry | undefined
}
