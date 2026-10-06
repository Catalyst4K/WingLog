import { angleBetweenDeg, WRONG_WAY_DEG, type RemainingRoute } from './taxiRouteTrace'

/**
 * When the traced taxi line should be re-traced from where the aircraft is
 * (flightdeck-backend's docs/plans/taxi-reroute.md). Real case, ZJSY flight 227, 2026-10-02:
 * cleared "via D, B7, A" to A's runway 08 hold, pushed back facing the other way and taxied a
 * different route to the same hold, with the line pointing back along D the whole time.
 * Where a re-route goes is taxiRouteTrace.ts's rejoinTaxiRoute: the shortest total way to the
 * same end, joining the cleared route wherever that's shortest.
 *
 * Starting values, checked against that flight's replay (taxiReroute.test.ts):
 * - off the line: more than REROUTE_DISTANCE_M from it (a taxiway is ~23 m wide);
 * - or going the wrong way along it: heading more than WRONG_WAY_DEG off the line's direction;
 * - either one continuously for REROUTE_AFTER_MS while moving faster than
 *   REROUTE_MIN_SPEED_MS, so cutting a corner or a pause doesn't trigger it;
 * - at most one re-route per REROUTE_MIN_INTERVAL_MS, so a bad position can't make the line
 *   flicker.
 */
export const REROUTE_DISTANCE_M = 40
export const REROUTE_AFTER_MS = 5_000
export const REROUTE_MIN_INTERVAL_MS = 10_000
export const REROUTE_MIN_SPEED_MS = 1.03 // ~2 kt
/** Within this of the cleared route, a segment of it counts as driven; within this of the
 *  end, the clearance is done. */
export const DRIVEN_DISTANCE_M = 30

export interface DeviationState {
  /** When the current continuous deviation started; null while following the line. */
  deviatingSince: number | null
  lastRerouteAt: number | null
}

export const INITIAL_DEVIATION: DeviationState = { deviatingSince: null, lastRerouteAt: null }

export interface DeviationSample {
  nowMs: number
  /** remainingRoute's distance from, and direction of, the nearest part of the line. */
  distanceM: number
  lineBearingDeg: number | null
  headingDeg: number
  groundSpeedMs: number
}

export function checkDeviation(state: DeviationState, sample: DeviationSample): { reroute: boolean; state: DeviationState } {
  const moving = sample.groundSpeedMs > REROUTE_MIN_SPEED_MS
  const offLine = sample.distanceM > REROUTE_DISTANCE_M
  const wrongWay =
    !offLine && sample.lineBearingDeg !== null && angleBetweenDeg(sample.headingDeg, sample.lineBearingDeg) > WRONG_WAY_DEG
  if (!moving || !(offLine || wrongWay)) return { reroute: false, state: { ...state, deviatingSince: null } }

  const since = state.deviatingSince ?? sample.nowMs
  const longEnough = sample.nowMs - since >= REROUTE_AFTER_MS
  const intervalOk = state.lastRerouteAt === null || sample.nowMs - state.lastRerouteAt >= REROUTE_MIN_INTERVAL_MS
  if (longEnough && intervalOk) return { reroute: true, state: { deviatingSince: null, lastRerouteAt: sample.nowMs } }
  return { reroute: false, state: { ...state, deviatingSince: since } }
}

/** The furthest segment of the cleared route the aircraft has driven: the one it's on, once
 *  within DRIVEN_DISTANCE_M of it. Never goes back. */
export function segmentDriven(remaining: RemainingRoute, current: number): number {
  return remaining.distanceM > DRIVEN_DISTANCE_M ? current : Math.max(current, remaining.segment)
}

/** Whether the aircraft has got to the end of the line (the hold, or the stand). From then on
 *  the clearance is done and nothing re-routes: lining up past the hold isn't a deviation. */
export function reachedEnd(route: [number, number][], position: { lat: number; lon: number }): boolean {
  const end = route.at(-1)
  if (!end) return false
  const cosLat = Math.cos((position.lat * Math.PI) / 180)
  const distanceM = Math.hypot((end[1] - position.lat) * 111_320, (end[0] - position.lon) * 111_320 * cosLat)
  return distanceM <= DRIVEN_DISTANCE_M
}
