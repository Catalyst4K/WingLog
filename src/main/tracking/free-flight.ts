import type { FlightPhase, SimTelemetry } from '@shared/ipc'
import { parseAircraftIdentity } from '../aircraft-lookup/aircraft-identity'
import { nearestAirport } from '../airports/airport-search'
import type { WingLogDb } from '../db/client'
import { getAircraftIdForTitle } from '../db/settings-repo'
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

// A current-position lookup (parked at a gate, holding short, wherever the pilot happens to
// be when the dialog opens) rather than a touchdown position — wider than
// TrackingController's own 5nm landing-icao radius, since there's no guarantee the aircraft
// is anywhere near a runway threshold when free-flight tracking starts.
const FREE_FLIGHT_POSITION_SEARCH_RADIUS_NM = 15

export interface FreeFlightPrefill {
  /** Straight from parseAircraftIdentity — see that function's own doc comments. */
  registration: string
  icaoType: string | null
  icaoTypeAmbiguous: boolean
  /** nearestAirport at the current position, or null if nothing vendored is close enough —
   *  the dialog's Departure field prefill (free-flight-tracking.md's dialog table). */
  suggestedDepIcao: string | null
  /** A fleet aircraft previously remembered for this exact `title` (rememberAircraftForTitle,
   *  settings-repo.ts), or null if this add-on has never been seen before. The dialog's own
   *  fleet-match-on-atcId step happens client-side, since the renderer already has the full
   *  aircraft list loaded — this only covers the step that needs main-process state. */
  rememberedAircraftId: number | null
}

/**
 * Composes everything the "Start a free flight" dialog needs to prefill itself, in one IPC
 * round trip rather than three — free-flight-tracking.md's aircraft-resolution table plus
 * the Departure field. Read-only: never writes the title memory itself (startFree does that,
 * once the pilot actually confirms an aircraft — see TrackingController.startFree).
 */
export function getFreeFlightPrefill(
  db: WingLogDb,
  input: { atcId: string; atcModel: string; title: string; latitude: number; longitude: number }
): FreeFlightPrefill {
  const identity = parseAircraftIdentity(input)
  return {
    ...identity,
    suggestedDepIcao: nearestAirport(input.latitude, input.longitude, FREE_FLIGHT_POSITION_SEARCH_RADIUS_NM),
    rememberedAircraftId: getAircraftIdForTitle(db, input.title) ?? null
  }
}
