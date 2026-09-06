/**
 * Pure crosswind/headwind/centreline/distance-from-threshold maths for landing analysis
 * (PLAN.md M6, docs/decisions.md). No IO, no SimConnect — takes plain numbers so it's
 * exactly checkable by hand (e.g. wind directly down the runway = zero crosswind).
 */

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180
}

/** Shortest angular difference between two headings, 0-180. */
export function angularDifference(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360
  return diff > 180 ? 360 - diff : diff
}

/**
 * Wind direction is where the wind is blowing FROM (SimConnect/METAR convention, same as
 * SimTelemetry.windDirectionDeg). A headwind is positive; a tailwind is negative. Wind
 * blowing from exactly the runway heading (straight down the runway, into the aircraft)
 * is a pure headwind with zero crosswind.
 */
export function headwindComponent(
  windSpeedMs: number,
  windDirectionDeg: number,
  runwayHeadingDeg: number
): number {
  return windSpeedMs * Math.cos(toRadians(windDirectionDeg - runwayHeadingDeg))
}

/** Positive = crosswind from the right (looking down the runway heading), negative = from the left. */
export function crosswindComponent(
  windSpeedMs: number,
  windDirectionDeg: number,
  runwayHeadingDeg: number
): number {
  return windSpeedMs * Math.sin(toRadians(windDirectionDeg - runwayHeadingDeg))
}

/**
 * Signed angle between the aircraft's nose and the runway centreline at touchdown —
 * how much crab was still held rather than fully kicked out before the wheels touched.
 * Positive = nose right of the runway heading, negative = left (same left/right
 * convention as crosswindComponent), wrapped to (-180, 180].
 */
export function crabAngleDeg(headingTrueDeg: number, runwayHeadingDeg: number): number {
  let diff = (headingTrueDeg - runwayHeadingDeg) % 360
  if (diff > 180) diff -= 360
  if (diff <= -180) diff += 360
  return diff
}

const METERS_PER_DEG_LAT = 111_320

function metersPerDegLon(atLatDeg: number): number {
  return METERS_PER_DEG_LAT * Math.cos(toRadians(atLatDeg))
}

export interface RunwayRelativePosition {
  /** Along the runway centreline from the threshold, in the direction of travel. */
  distanceFromThresholdM: number
  /** Perpendicular to the centreline — positive = right of centreline, negative = left. */
  centrelineOffsetM: number
}

/**
 * Decomposes an aircraft position into along-track/cross-track components relative to a
 * runway threshold and heading, using a flat-earth approximation (metres per degree
 * lat/lon at the threshold's latitude) — accurate enough at runway scale (a few km at
 * most), not intended for anything longer-range.
 */
export function positionRelativeToRunway(
  aircraftLat: number,
  aircraftLon: number,
  thresholdLat: number,
  thresholdLon: number,
  runwayHeadingDeg: number
): RunwayRelativePosition {
  const northM = (aircraftLat - thresholdLat) * METERS_PER_DEG_LAT
  const eastM = (aircraftLon - thresholdLon) * metersPerDegLon(thresholdLat)
  const headingRad = toRadians(runwayHeadingDeg)

  return {
    distanceFromThresholdM: northM * Math.cos(headingRad) + eastM * Math.sin(headingRad),
    centrelineOffsetM: eastM * Math.cos(headingRad) - northM * Math.sin(headingRad)
  }
}
