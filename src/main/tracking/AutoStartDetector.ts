import { EventEmitter } from 'node:events'
import type { SimTelemetry } from '@shared/ipc'
import { airportPosition } from '../airports/runway-lookup'
import type { SimConnectService } from '../sim/SimConnectService'

// scripts/spike-flight-reload.ts, sim-confirmed against a real MSFS 2024 reload (see
// docs/decisions.md): loading a different flight produces roughly a minute of telemetry
// that individually *looks* plausible but isn't — `onGround` flips true a good ~30s
// before altitude has caught up, and altitude itself doesn't monotonically settle: it
// spikes to a garbage plateau (tens of thousands of feet) and holds there rock-steady
// for several seconds at a time before continuing to decay. So neither "onGround is
// true" nor "this value hasn't changed in N samples" is safe alone — both are required,
// plus a sanity ceiling on the absolute altitude, since the garbage plateaus sit far
// above any real airport's elevation.
const STABLE_SAMPLES_REQUIRED = 8
const MAX_PLAUSIBLE_GROUND_ALTITUDE_M = 3000 // ~9,800ft — comfortably above all but a handful of real airports worldwide, far below the reload spike's ~16,000-54,000ft garbage plateaus
const ALTITUDE_STABLE_EPSILON_M = 1.5
const POSITION_STABLE_EPSILON_DEG = 0.0005 // ~55m — stationary-at-gate jitter, not real taxi movement
const GROUND_SPEED_STABLE_EPSILON_MS = 0.3 // ~0.6kt
// Callum reported a real case this misses without a location check: MSFS's own flight-
// picker/World Map screen runs a live background scene (parked, on the ground, perfectly
// stationary — e.g. sitting at Boeing Field) that satisfies every check above just as well
// as a genuinely armed, parked flight does. Arming happens on WingLog's "Fly" (a
// `flightCreate`), which can land before the sim has even loaded the real flight if MSFS
// is still on that menu — so this fired against the menu's placeholder position, then the
// real load-in teleported the aircraft to the actual departure airport, recording one
// breadcrumb trail straight across the globe between the two. A coarse "is this even
// roughly at the departure airport" check rejects that placeholder position without
// needing precision — real GPS/telemetry jitter and an airport's own physical size are
// both far smaller than this. Plain Euclidean degrees (no cosine correction for
// longitude), so the real km this represents varies with latitude — irrelevant here,
// since it's only ever used as a "wildly, implausibly wrong" filter (~120km at the
// equator), not a precise distance.
const MAX_DEPARTURE_DISTANCE_DEG = 1.1

/**
 * Watches SimConnect telemetry after a flight is armed (Dispatch's "Fly" button) and
 * fires once the sim shows a genuinely settled, on-the-ground aircraft — the auto-start
 * half of "hopefully the Start tracking button is unnecessary". Requires several
 * consecutive seconds of plausible, unchanging data (on the ground, altitude under a
 * sanity ceiling, position and altitude both static) rather than trusting any single
 * sample — seeded on the real reload behaviour captured by scripts/spike-flight-reload.ts
 * (see docs/decisions.md), which showed that a mid-reload garbage plateau can otherwise
 * look "stable" for several ticks at a time.
 *
 * Earlier revision required an actual *disturbance* from the armed baseline before
 * counting stable samples, on the assumption a reload always happens after arming — but
 * Callum's real usage flow is often the other way round (load the flight in MSFS first,
 * *then* press Fly), so that precondition just meant it silently never fired. Dropped:
 * the reload-garbage window is already rejected on its own physical implausibility (not
 * on the ground yet, or altitude far too high, or still changing) — nothing about that
 * protection actually depended on requiring a disturbance first. The trade-off this
 * accepted: if the sim is left mid-transition from a *different* previous flight (stale
 * position at the wrong airport) for the full ~8s stability window right as Fly is
 * pressed, it could start against that stale data. **That trade-off turned out to bite
 * for real** (Callum, 2026-09-03): MSFS's own flight-picker/World Map screen runs a live
 * background scene — parked, on the ground, perfectly stationary — that's indistinguishable
 * from a real armed flight by every check above. Arming happens on WingLog's "Fly"
 * (`flightCreate`), which can land while MSFS is still sitting on that menu, so this fired
 * against the menu's placeholder position and then the real load-in teleported the
 * aircraft to the actual departure airport — one breadcrumb trail straight across the
 * globe between the two. Fixed with a coarse "is this even roughly at the armed flight's
 * departure airport" check (see MAX_DEPARTURE_DISTANCE_DEG) rather than requiring an
 * upfront disturbance again, which the comment above already explains doesn't fit
 * Callum's usual flow. Dispatch's "Fly" confirmation dialog and the manual "Start
 * tracking" button remain as guardrails for whatever this still doesn't catch (e.g. two
 * airports that happen to be within the coarse threshold of each other).
 */
export class AutoStartDetector extends EventEmitter<{ ready: [number] }> {
  private armedFlightId: number | undefined
  private previous: SimTelemetry | undefined
  private stableCount = 0
  private referencePosition: { lat: number; lon: number } | null = null

  constructor(
    simConnectService: SimConnectService,
    private readonly resolveAirportPosition: (icao: string) => { lat: number; lon: number } | null = airportPosition
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
