/**
 * A synthetic "Visual <runway>" approach (winglog-backend docs/plans/visual-approach.md):
 * real ATC — and BeyondATC — routinely clear a visual approach after a STAR, and every
 * approach the sim's navdata offers is an instrument procedure. There's no navdata behind
 * this one, so it's built here from the runway's own cached threshold and heading, and
 * looks to everything downstream (the selector, `useLiveWaypoints`, `applyProcedureSelection`,
 * flight persistence — a plain identifier string) exactly like a real approach.
 */
import type { NavdataLeg, NavdataProcedureOption } from '@shared/ipc'
import { visualApproachIdentifier } from '@shared/visual-approach'
import { offsetAlongBearing } from '../airports/landing-maths'

/** How far out along the extended centreline the visual approach's join point is drawn.
 *  A drawing convention, not a rule — there is no single regulatory figure (the plan doc
 *  discusses 5-15 nm); a setting is deferred, so this is the one place to change it. */
export const VISUAL_JOIN_DISTANCE_NM = 10

const METRES_PER_NM = 1852

/** The only transition offered: a straight line from the STAR's last fix to the join point
 *  (the approach's first waypoint, so `applyProcedureSelection` draws it for free). */
export const VISUAL_VECTORS_TRANSITION = 'Vectors'

export interface VisualRunwayEnd {
  ident: string
  headingTrueDeg: number
  thresholdLat: number
  thresholdLon: number
}

/** One `Visual <rwy>` option (transition: Vectors) per runway end, optionally only for
 *  `runway` — mirrors listCachedProcedures' own runway filter.
 *
 * @param runways The airport's runway ends.
 * @param runway Only this runway's, or null for all.
 * @returns One option per runway end.
 */
export function visualApproachOptions(runways: VisualRunwayEnd[], runway: string | null): NavdataProcedureOption[] {
  return runways
    .filter((r) => !runway || r.ident === runway)
    .map((r) => ({ identifier: visualApproachIdentifier(r.ident), transition: VISUAL_VECTORS_TRANSITION }))
}

/** offsetAlongBearing doesn't wrap: a runway just west of the antimeridian heading out east
 *  lands past 180 degrees.
 *
 * @param lon Degrees, any value.
 * @returns Degrees, -180 to 180.
 */
function wrapLongitude(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180
}

function syntheticLeg(type: number, fixIdent: string, fixType: 'W' | 'R', lat: number, lon: number): NavdataLeg {
  return {
    type,
    fixIdent,
    fixType,
    fixLatitude: lat,
    fixLongitude: lon,
    turnDirection: 0,
    courseDeg: 0,
    altitude1: 0,
    altitude2: 0,
    speedLimit: 0,
    routeDistanceM: 0
  }
}

/** The approach's two waypoints: the join point, `VISUAL_JOIN_DISTANCE_NM` back along the
 *  runway's reciprocal true heading, then the threshold. The join point is labelled
 *  "<rwy>/<nm>" like the FMC's own distance fixes (e.g. LAM/11).
 *
 * @param runway The runway end.
 * @returns The join point, then the threshold.
 */
export function visualApproachLegs(runway: VisualRunwayEnd): NavdataLeg[] {
  const join = offsetAlongBearing(
    runway.thresholdLat,
    runway.thresholdLon,
    (runway.headingTrueDeg + 180) % 360,
    VISUAL_JOIN_DISTANCE_NM * METRES_PER_NM
  )
  return [
    syntheticLeg(15, `${runway.ident}/${VISUAL_JOIN_DISTANCE_NM}`, 'W', join.lat, wrapLongitude(join.lon)),
    syntheticLeg(18, `RW${runway.ident}`, 'R', runway.thresholdLat, runway.thresholdLon)
  ]
}
