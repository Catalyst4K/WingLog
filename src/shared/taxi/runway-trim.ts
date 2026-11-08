/**
 * Keeps the end of a holding-point line off the runway. A holding point's taxiway can run on to the runway and even along it (EGLL's A1,
 * "taxi to holding point A1, runway 27R", has no hold short flag where the aircraft stops and is a path that ends 150 m along the runway on
 * its centreline), so the traced line, and the hold-short bar at its end, went well onto the runway. The line is cut back to where it
 * leaves the runway's strip plus a margin, the holding position a pilot stops at.
 */

import { alongAndAcross } from './runway-crossing'
import type { RunwayStrip, TracedRoute } from './route-types'

/** How far outside a runway's edge the line ends: about where a holding position marking is, though real ones are further out. */
export const HOLD_OFF_RUNWAY_M = 40

/**
 * @param point A [lon, lat] position.
 * @param runway The runway.
 * @returns How far the point is from the runway's centreline beyond its half width plus the margin (negative: inside that zone), or null when
 *   it is not beside the runway's length at all.
 */
function outsideBy(point: [number, number], runway: RunwayStrip): number | null {
  const { along, across } = alongAndAcross({ lat: point[1], lon: point[0] }, runway)
  if (along < 0 || along > runway.lengthM) return null
  return Math.abs(across) - (runway.widthM / 2 + HOLD_OFF_RUNWAY_M)
}

/**
 * @param point A [lon, lat] position.
 * @param runways The airport's runways.
 * @returns The runway whose strip (with the margin) the point is in, or null.
 */
function runwayAround(point: [number, number], runways: RunwayStrip[]): RunwayStrip | null {
  return runways.find((runway) => (outsideBy(point, runway) ?? 1) < 0) ?? null
}

/**
 * Cuts the end of a line back to just outside the runway it runs onto.
 *
 * @param route The traced line, ending at a holding point.
 * @param runways The airport's runways as strips.
 * @returns The line, ended where it leaves the strip of the runway its end is on; `route` itself when its end is not on a runway or it is
 *   on one from its first point (nothing to cut back to).
 */
export function endOffRunway(route: TracedRoute, runways: RunwayStrip[]): TracedRoute {
  const end = route.at(-1)
  const runway = end ? runwayAround(end, runways) : null
  if (!runway) return route
  let last = route.length - 1
  while (last > 0 && (outsideBy(route[last - 1] as [number, number], runway) ?? 1) < 0) last--
  if (last === 0) return route
  const outside = route[last - 1] as [number, number]
  const inside = route[last] as [number, number]
  const gone = outsideBy(outside, runway) ?? 0
  const left = outsideBy(inside, runway) ?? 0
  // Where the segment from the last outside point crosses the margin, so the line ends on it and not at the next point in.
  const share = gone / (gone - left)
  const cut: [number, number] = [
    outside[0] + (inside[0] - outside[0]) * share,
    outside[1] + (inside[1] - outside[1]) * share
  ]
  return [...route.slice(0, last), cut]
}

/**
 * @param runway A runway's fields from the airport data.
 * @returns The runway as a strip.
 */
export function stripOf(runway: {
  thresholdLat: number
  thresholdLon: number
  headingTrueDeg: number
  lengthM: number
  widthM: number
}): RunwayStrip {
  return {
    thresholdLat: runway.thresholdLat,
    thresholdLon: runway.thresholdLon,
    headingTrueDeg: runway.headingTrueDeg,
    lengthM: runway.lengthM,
    widthM: runway.widthM
  }
}
