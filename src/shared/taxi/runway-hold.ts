/**
 * Which hold short is "the holding point" of a runway when the clearance only names the runway ("taxi holding point runway 02C via P, T").
 * A taxiway alongside a runway has a hold short at every entry to it; BeyondATC's route runs on to the last one, the entry at the very
 * start of the runway, which is where a pilot lines up for the full length (WSSS 2026-10-19: T11 and T12 are entries part-way along 02C,
 * and the flown taxi went on past both to the one behind the threshold). The search's first hold short is the nearest, not that one.
 */

import type { NavdataTaxiSegment } from '@shared/ipc'

/** The runway's threshold, and the way it points when the airport data has it. */
export interface RunwayThreshold {
  lat: number
  lon: number
  headingDeg?: number
}

/** A hold short is beside a runway's threshold when it is this near it. The trace also ends a holding-point route at any flagged hold short
 *  this near the threshold when none of the holding-point taxiway's is (WSSS "taxi holding point runway 02C via P, T": T has no flagged
 *  points, and the holding point is on its T12 branch). */
export const HOLD_NEAR_THRESHOLD_M = 250

const METRES_PER_DEGREE = 111_320

/**
 * @param point A position.
 * @param threshold The runway's threshold.
 * @param headingDeg The runway's heading.
 * @returns How far along the runway from its threshold the point is (negative before it), and how far to the right of it.
 */
function alongAndAcross(
  point: { lat: number; lon: number },
  threshold: { lat: number; lon: number },
  headingDeg: number
): { along: number; across: number } {
  const north = (point.lat - threshold.lat) * METRES_PER_DEGREE
  const east = (point.lon - threshold.lon) * METRES_PER_DEGREE * Math.cos((threshold.lat * Math.PI) / 180)
  const heading = (headingDeg * Math.PI) / 180
  return {
    along: north * Math.cos(heading) + east * Math.sin(heading),
    across: east * Math.cos(heading) - north * Math.sin(heading)
  }
}

/**
 * @param segments The airport's taxi network.
 * @param threshold The runway's threshold.
 * @returns Every flagged hold short within HOLD_NEAR_THRESHOLD_M of the threshold, once each.
 */
function holdPointsNear(
  segments: NavdataTaxiSegment[],
  threshold: { lat: number; lon: number }
): { lat: number; lon: number }[] {
  const found = new Map<string, { lat: number; lon: number }>()
  const consider = (lat: number, lon: number, holdShort: boolean): void => {
    if (!holdShort) return
    const { along, across } = alongAndAcross({ lat, lon }, threshold, 0)
    if (Math.hypot(along, across) <= HOLD_NEAR_THRESHOLD_M) found.set(`${lat},${lon}`, { lat, lon })
  }
  for (const s of segments) {
    consider(s.startLat, s.startLon, s.startHoldShort)
    consider(s.endLat, s.endLon, s.endHoldShort)
  }
  return [...found.values()]
}

/**
 * The hold shorts at the very start of the runway, one on each side of it: of those near the threshold, the furthest back along the
 * runway on either side. A clearance that names only the runway ends at one of these (a full-length departure).
 *
 * @param segments The airport's taxi network.
 * @param threshold The runway's threshold.
 * @returns The furthest-back hold short of each side. Every hold short near the threshold when the runway's heading is not known.
 */
export function startOfRunwayHolds(
  segments: NavdataTaxiSegment[],
  threshold: RunwayThreshold
): { lat: number; lon: number }[] {
  const near = holdPointsNear(segments, threshold)
  const heading = threshold.headingDeg
  if (heading === undefined) return near
  const bySide = new Map<number, { lat: number; lon: number; along: number }>()
  for (const point of near) {
    const { along, across } = alongAndAcross(point, threshold, heading)
    const side = Math.sign(across)
    const best = bySide.get(side)
    if (!best || along < best.along) bySide.set(side, { ...point, along })
  }
  return [...bySide.values()].map(({ lat, lon }) => ({ lat, lon }))
}

/**
 * The hold short at the very start of the runway, on the side the route reached it from: of the hold shorts near the threshold that
 * are on the same side of the runway as the one the search reached first, the one furthest back along the runway.
 *
 * @param segments The airport's taxi network.
 * @param reached The hold short the search reached first.
 * @param threshold The runway's threshold.
 * @returns The furthest-back hold short on that side, or null when the runway's heading is not known or nothing is further back.
 */
export function furthestBackHold(
  segments: NavdataTaxiSegment[],
  reached: { lat: number; lon: number },
  threshold: RunwayThreshold
): { lat: number; lon: number } | null {
  const heading = threshold.headingDeg
  if (heading === undefined) return null
  const side = Math.sign(alongAndAcross(reached, threshold, heading).across)
  let best: { lat: number; lon: number; along: number } | null = null
  for (const point of holdPointsNear(segments, threshold)) {
    const { along, across } = alongAndAcross(point, threshold, heading)
    if (Math.sign(across) === side && (!best || along < best.along)) best = { ...point, along }
  }
  const reachedAlong = alongAndAcross(reached, threshold, heading).along
  return best && best.along < reachedAlong - 1 ? { lat: best.lat, lon: best.lon } : null
}
