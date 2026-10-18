/**
 * Starts tracking a dispatched flight on its own once the aircraft really moves at the departure,
 * so the pilot doesn't have to press Start.
 */
import { EventEmitter } from 'node:events'
import type { SimTelemetry } from '@shared/ipc'
import { airportPosition } from '../airports/runway-lookup'
import type { SimConnectSource } from '../sim/SimConnectSource'

// scripts/spike-flight-reload.ts, sim-confirmed against a real MSFS 2024 reload (docs/decisions.md): loading a different
// flight produces roughly a minute of telemetry that individually *looks* plausible but isn't. `onGround` flips true ~30s
// before altitude has caught up, and altitude spikes to a garbage plateau (tens of thousands of feet) and holds there
// rock-steady for several seconds before decaying. So neither "onGround is true" nor "this value hasn't changed in N
// samples" is safe alone: both are required, plus a sanity ceiling on the absolute altitude, since the garbage plateaus sit
// far above any real airport's elevation.
const STABLE_SAMPLES_REQUIRED = 8
const MAX_PLAUSIBLE_GROUND_ALTITUDE_M = 3000 // ~9,800ft — comfortably above all but a handful of real airports worldwide, far below the reload spike's ~16,000-54,000ft garbage plateaus
const ALTITUDE_STABLE_EPSILON_M = 1.5
const POSITION_STABLE_EPSILON_DEG = 0.0005 // ~55m — stationary-at-gate jitter, not real taxi movement
const GROUND_SPEED_STABLE_EPSILON_MS = 0.3 // ~0.6kt
// A location check is needed too: MSFS's flight-picker/World Map screen runs a live background scene (parked, on the ground,
// perfectly stationary) that satisfies every check above as well as a genuinely armed, parked flight does. Arming happens on
// WingLog's "Fly" (`flightCreate`), which can land before the sim has loaded the real flight, so this fired against the
// menu's placeholder position and the real load-in then teleported the aircraft to the departure airport, recording one
// breadcrumb trail across the globe. A coarse "is this roughly at the departure airport" check rejects that placeholder
// without needing precision: GPS jitter and an airport's size are far smaller than this. Plain Euclidean degrees (no
// cosine correction for longitude), so the km it represents varies with latitude (~120 km at the equator); it is only a
// "wildly, implausibly wrong" filter.
const MAX_DEPARTURE_DISTANCE_DEG = 1.1

/**
 * Watches SimConnect telemetry after a flight is armed (Dispatch's "Fly" button) and fires once the sim shows a settled,
 * on-the-ground aircraft: the auto-start half of making the Start tracking button unnecessary. Requires several consecutive
 * seconds of plausible, unchanging data (on the ground, altitude under a sanity ceiling, position and altitude both static)
 * rather than trusting any single sample, because a mid-reload garbage plateau can look "stable" for several ticks
 * (scripts/spike-flight-reload.ts, docs/decisions.md).
 *
 * It does not require a *disturbance* from the armed baseline first: the usual flow is to load the flight in MSFS and then
 * press Fly, so that precondition meant it never fired, and the reload-garbage window is already rejected on its own
 * implausibility (not on the ground yet, altitude too high, or still changing). The cost: if the sim sits mid-transition from
 * a *different* previous flight for the full ~8s window right as Fly is pressed, it could start against stale data. That
 * happened with MSFS's flight-picker scene (see MAX_DEPARTURE_DISTANCE_DEG); the coarse departure-airport check covers it.
 * Dispatch's "Fly" confirmation dialog and the manual "Start tracking" button remain as guardrails for what it still
 * misses (e.g. two airports within the coarse threshold of each other).
 */
export class AutoStartDetector extends EventEmitter<{ ready: [number] }> {
  private armedFlightId: number | undefined
  private previous: SimTelemetry | undefined
  private stableCount = 0
  private referencePosition: { lat: number; lon: number } | null = null

  constructor(
    simConnectService: SimConnectSource,
    private readonly resolveAirportPosition: (
      icao: string
    ) => { lat: number; lon: number } | null = airportPosition
  ) {
    super()
    simConnectService.on('telemetry', (telemetry) => this.ingest(telemetry))
  }

  /**
   * Arms the watch for a freshly created flight. `currentTelemetry` (the sim's state at
   * the moment "Fly" was pressed) seeds the first delta comparison — if the sim isn't
   * connected yet, there's nothing to compare the first real sample against, so counting
   * starts from the sample after that one instead. `depIcao` anchors the departure-position
   * sanity check below; when it's not in the vendored runway data (see runway-lookup.ts),
   * `resolveAirportPosition` returns null and that check is skipped entirely, same as
   * before this existed.
   *
   * @param flightId The flight just dispatched.
   * @param currentTelemetry The sim's state when Fly was pressed, or undefined with no sim yet.
   * @param depIcao The departure, for the position check.
   */
  arm(flightId: number, currentTelemetry: SimTelemetry | undefined, depIcao: string): void {
    this.armedFlightId = flightId
    this.previous = currentTelemetry
    this.stableCount = 0
    this.referencePosition = this.resolveAirportPosition(depIcao)
  }

  /** Stops watching without firing — the armed flight was cancelled, or tracking already
   *  started some other way (e.g. the manual button) before this got there. */
  disarm(): void {
    this.armedFlightId = undefined
    this.previous = undefined
    this.stableCount = 0
    this.referencePosition = null
  }

  private ingest(telemetry: SimTelemetry): void {
    if (this.armedFlightId === undefined) return

    this.stableCount = this.isStableStep(telemetry) ? this.stableCount + 1 : 0
    this.previous = telemetry

    if (this.stableCount >= STABLE_SAMPLES_REQUIRED) {
      const flightId = this.armedFlightId
      this.disarm()
      this.emit('ready', flightId)
    }
  }

  private isStableStep(telemetry: SimTelemetry): boolean {
    if (!telemetry.onGround) return false
    if (telemetry.latitude === 0 && telemetry.longitude === 0) return false
    if (telemetry.altitudeM > MAX_PLAUSIBLE_GROUND_ALTITUDE_M) return false
    if (Math.abs(telemetry.groundSpeedMs) > GROUND_SPEED_STABLE_EPSILON_MS) return false
    if (this.referencePosition) {
      const latDiff = telemetry.latitude - this.referencePosition.lat
      const lonDiff = telemetry.longitude - this.referencePosition.lon
      if (Math.hypot(latDiff, lonDiff) > MAX_DEPARTURE_DISTANCE_DEG) return false
    }
    if (!this.previous) return false
    if (Math.abs(telemetry.latitude - this.previous.latitude) > POSITION_STABLE_EPSILON_DEG) return false
    if (Math.abs(telemetry.longitude - this.previous.longitude) > POSITION_STABLE_EPSILON_DEG) return false
    if (Math.abs(telemetry.altitudeM - this.previous.altitudeM) > ALTITUDE_STABLE_EPSILON_M) return false
    return true
  }
}
