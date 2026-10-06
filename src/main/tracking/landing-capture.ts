/**
 * One landing record from a touchdown tick: rate, g, attitude, wind components, and position on
 * the runway.
 */
import type { SimTelemetry } from '@shared/ipc'
import {
  crabAngleDeg,
  crosswindComponent,
  headwindComponent,
  positionRelativeToRunway
} from '../airports/landing-maths'
import { distanceFromUsableThresholdM, findRunwayEnd, type RunwayEnd } from '../airports/runway-lookup'
import type { NewLanding } from '@shared/ipc'
import type { TouchdownSeverity } from '../sim/SimConnectSource'

// Sanity clamp on G-force alone (PLAN.md §7's open risk register: a payware aircraft with
// unused/miscalibrated SimVars can report an obviously-impossible reading). Range is
// deliberately generous — a hard landing can genuinely spike well above 1g — this only
// guards against something like a glider reporting NaN or a wildly implausible value, not
// against a real firm/hard landing reading high.
const MIN_PLAUSIBLE_G_FORCE = -3
const MAX_PLAUSIBLE_G_FORCE = 6

function clampGForce(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(Math.max(value, MIN_PLAUSIBLE_G_FORCE), MAX_PLAUSIBLE_G_FORCE)
}

/**
 * Builds one landing record from the telemetry tick where TrackingController detects a
 * touchdown — the raw on-ground false->true transition (winglog-backend's docs/plans/
 * multiple-landings.md), not the phase machine's descent -> landing edge, which has real
 * holes for circuit flying. Always uses the ingested tick's own values for
 * pitch/bank/g-force/position ("derived") rather than a dedicated touchdown SimVar — MSFS
 * 2024's `PLANE TOUCHDOWN *` vars are unverified (docs/decisions.md, landing-analysis
 * entry; scripts/spike-landing.ts is ready to confirm them on a real flight).
 * `resolveRunway` is injectable for testing; defaults to the real vendored lookup.
 *
 * `icao` is this specific touchdown's own resolved airport (TrackingController's
 * nearestAirport-then-flight.arrIcao-fallback), not assumed to be the flight's filed
 * arrival — a circuit, a diversion, or (once free-flight-tracking.md lands) a flight with
 * no filed arrival at all can touch down somewhere else. Null skips runway resolution
 * entirely, same as an unresolvable one already did.
 *
 * Vertical speed prefers `touchdownSeverity` (v1.2 Part 1, SimConnectService's second
 * high-rate stream) when given: the peak vertical speed in the last second before ground
 * contact, sampled far more densely than the primary 1 Hz stream. Real flights
 * (docs/simconnect-notes.md, 2026-09-20) found the 1 Hz-derived value below can miss true
 * touchdown severity by 55-87%, in either direction depending on where the 1-second grid
 * happens to fall relative to each landing's own flare — the high-rate reading fixes that
 * directly instead of guessing at a correction factor.
 *
 * Falls back to `previousTelemetry` (the last sample *before* on-ground flipped true) when
 * no high-rate reading is available (a replayed flight, or a live one where the high-rate
 * stream didn't arm in time). Real comparison against an independent landing-rate tool
 * (winglog-backend's docs/plans/flight-replay-harness.md, 2026-09-14) found the touchdown
 * tick's own value under-reads true impact severity by 55-87% — a full second of gear
 * compression has usually already happened by the time on-ground reads true at 1 Hz. Falls
 * back further still to the touchdown tick's own value if neither is available (e.g.
 * touchdown detected on the very first tick after a resume).
 *
 * @param flightId The flight.
 * @param seq Which of its landings, from 1.
 * @param icao The airport touched down at, or null to skip the runway.
 * @param telemetry The touchdown tick.
 * @param touchdownTsUtc When, ISO UTC.
 * @param resolveRunway Finds the runway end; the vendored lookup by default.
 * @param previousTelemetry The tick before touchdown.
 * @param touchdownSeverity The high-rate stream's reading, if any.
 * @returns The landing, ready to insert.
 */
export function buildLandingRecord(
  flightId: number,
  seq: number,
  icao: string | null,
  telemetry: SimTelemetry,
  touchdownTsUtc: string,
  resolveRunway: (
    icao: string,
    headingDeg: number,
    lat: number,
    lon: number
  ) => RunwayEnd | null = findRunwayEnd,
  previousTelemetry?: SimTelemetry,
  touchdownSeverity?: TouchdownSeverity
): NewLanding {
  const runway = icao ? resolveRunway(icao, telemetry.headingTrueDeg, telemetry.latitude, telemetry.longitude) : null

  return {
    flightId,
    seq,
    icao,
    touchdownTsUtc,
    verticalSpeedMs: touchdownSeverity?.verticalSpeedMs ?? previousTelemetry?.verticalSpeedMs ?? telemetry.verticalSpeedMs,
    gForce: clampGForce(telemetry.gForce),
    pitchDeg: telemetry.pitchDeg,
    bankDeg: telemetry.bankDeg,
    headingTrueDeg: telemetry.headingTrueDeg,
    indicatedAirspeedMs: telemetry.indicatedAirspeedMs,
    groundSpeedMs: telemetry.groundSpeedMs,
    windSpeedMs: telemetry.windSpeedMs,
    windDirectionDeg: telemetry.windDirectionDeg,
    ...runwayFields(telemetry, runway),
    flapSetting: Number.isFinite(telemetry.flapsHandleIndex) ? telemetry.flapsHandleIndex : null,
    touchdownSource: 'derived'
  }
}

/** The landing's fields that need the runway: all null when it couldn't be resolved. */
type RunwayFields = Pick<
  NewLanding,
  'headwindMs' | 'crosswindMs' | 'crabDeg' | 'runwayIdent' | 'distanceFromThresholdM' | 'centrelineOffsetM'
>

/**
 * Wind components, crab and position relative to the runway touched down on.
 *
 * @param telemetry The touchdown tick.
 * @param runway The runway end, or null when it couldn't be resolved.
 * @returns The fields, or all null without a runway.
 */
function runwayFields(telemetry: SimTelemetry, runway: RunwayEnd | null): RunwayFields {
  if (!runway) {
    return { headwindMs: null, crosswindMs: null, crabDeg: null, runwayIdent: null, distanceFromThresholdM: null, centrelineOffsetM: null }
  }
  const position = positionRelativeToRunway(telemetry.latitude, telemetry.longitude, runway.lat, runway.lon, runway.headingTrueDeg)
  return {
    headwindMs: headwindComponent(telemetry.windSpeedMs, telemetry.windDirectionDeg, runway.headingTrueDeg),
    crosswindMs: crosswindComponent(telemetry.windSpeedMs, telemetry.windDirectionDeg, runway.headingTrueDeg),
    crabDeg: crabAngleDeg(telemetry.headingTrueDeg, runway.headingTrueDeg),
    runwayIdent: runway.ident,
    // From the usable (displacement-adjusted) threshold, not the physical end `position` is
    // measured from (runway-lookup.ts's RunwayEnd.lat explains the difference).
    distanceFromThresholdM: distanceFromUsableThresholdM(position, runway),
    centrelineOffsetM: position.centrelineOffsetM
  }
}
