import type { SimTelemetry } from '@shared/ipc'
import {
  crabAngleDeg,
  crosswindComponent,
  headwindComponent,
  positionRelativeToRunway
} from '../airports/landing-maths'
import { findRunwayEnd, type RunwayEnd } from '../airports/runway-lookup'
import type { NewLanding } from '../db/landing-repo'

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
 * Builds one landing record from the telemetry tick where TrackingController detects
 * touchdown (descent -> landing, on-ground false->true). Always uses the ingested tick's
 * own values for vertical speed/pitch/bank ("derived") rather than a dedicated touchdown
 * SimVar — MSFS 2024's `PLANE TOUCHDOWN *` vars are unverified (docs/decisions.md,
 * landing-analysis entry; scripts/spike-landing.ts is ready to confirm them on a real
 * flight). `resolveRunway` is injectable for testing; defaults to the real vendored
 * lookup.
 */
export function buildLandingRecord(
  flightId: number,
  arrIcao: string,
  telemetry: SimTelemetry,
  touchdownTsUtc: string,
  resolveRunway: (
    icao: string,
    headingDeg: number,
    lat: number,
    lon: number
  ) => RunwayEnd | null = findRunwayEnd
): NewLanding {
  const runway = resolveRunway(arrIcao, telemetry.headingTrueDeg, telemetry.latitude, telemetry.longitude)
  const position = runway
    ? positionRelativeToRunway(
        telemetry.latitude,
        telemetry.longitude,
        runway.lat,
        runway.lon,
        runway.headingTrueDeg
      )
    : null

  return {
    flightId,
    touchdownTsUtc,
    verticalSpeedMs: telemetry.verticalSpeedMs,
    gForce: clampGForce(telemetry.gForce),
    pitchDeg: telemetry.pitchDeg,
    bankDeg: telemetry.bankDeg,
    headingTrueDeg: telemetry.headingTrueDeg,
    indicatedAirspeedMs: telemetry.indicatedAirspeedMs,
    groundSpeedMs: telemetry.groundSpeedMs,
    windSpeedMs: telemetry.windSpeedMs,
    windDirectionDeg: telemetry.windDirectionDeg,
    headwindMs: runway
      ? headwindComponent(telemetry.windSpeedMs, telemetry.windDirectionDeg, runway.headingTrueDeg)
      : null,
    crosswindMs: runway
      ? crosswindComponent(telemetry.windSpeedMs, telemetry.windDirectionDeg, runway.headingTrueDeg)
      : null,
    crabDeg: runway ? crabAngleDeg(telemetry.headingTrueDeg, runway.headingTrueDeg) : null,
    runwayIdent: runway?.ident ?? null,
    distanceFromThresholdM: position?.distanceFromThresholdM ?? null,
    centrelineOffsetM: position?.centrelineOffsetM ?? null,
    flapSetting: Number.isFinite(telemetry.flapsHandleIndex) ? telemetry.flapsHandleIndex : null,
    touchdownSource: 'derived'
  }
}
