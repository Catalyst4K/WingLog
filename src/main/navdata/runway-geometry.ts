/**
 * Each runway end's own threshold, worked out from the sim's runway record (a centre point and the
 * primary end's heading).
 */
import { offsetAlongBearing } from '../airports/landing-maths'
import type { ParsedRunway } from '../sim/facility-fields'

export interface DerivedRunwayEnd {
  ident: string
  headingTrueDeg: number
  lengthM: number
  widthM: number
  surface: number
  thresholdLat: number
  thresholdLon: number
}

/**
 * Splits one RUNWAY record — a physical strip, given as a centre point plus the primary
 * end's heading — into its two usable ends, deriving each end's own threshold from
 * centre ± length/2 along heading. RUNWAY.LATITUDE/LONGITUDE is confirmed live to be the
 * strip's centre point, not a threshold, and a FINAL_APPROACH_LEG's own runway-ident fix
 * resolves to that same centre for both ends too — this derivation is still necessary, not
 * something the facility API hands over for free (docs/navdata-notes.md).
 *
 * @param runway The sim's RUNWAY record.
 * @returns Both ends, primary first, each with its threshold, heading and size.
 */
export function runwayEndsFromCentre(runway: ParsedRunway): DerivedRunwayEnd[] {
  const halfLengthM = runway.lengthM / 2
  const secondaryHeadingDeg = (runway.headingDeg + 180) % 360
  // The primary end is reached by moving from centre *against* the primary heading — an
  // aircraft crosses this threshold, then rolls out in the primary-heading direction
  // toward the far (secondary) end.
  const primaryThreshold = offsetAlongBearing(runway.latitude, runway.longitude, runway.headingDeg, -halfLengthM)
  const secondaryThreshold = offsetAlongBearing(runway.latitude, runway.longitude, runway.headingDeg, halfLengthM)
  return [
    {
      ident: runway.primaryIdent,
      headingTrueDeg: runway.headingDeg,
      lengthM: runway.lengthM,
      widthM: runway.widthM,
      surface: runway.surface,
      thresholdLat: primaryThreshold.lat,
      thresholdLon: primaryThreshold.lon
    },
    {
      ident: runway.secondaryIdent,
      headingTrueDeg: secondaryHeadingDeg,
      lengthM: runway.lengthM,
      widthM: runway.widthM,
      surface: runway.surface,
      thresholdLat: secondaryThreshold.lat,
      thresholdLon: secondaryThreshold.lon
    }
  ]
}
