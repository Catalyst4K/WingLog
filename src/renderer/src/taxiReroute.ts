import { angleBetweenDeg, WRONG_WAY_DEG, type RemainingRoute } from './taxiRouteTrace'

/**
 * When the traced taxi line should be re-traced from where the aircraft is
 * (flightdeck-backend's docs/plans/taxi-reroute.md). Real case, ZJSY flight 227, 2026-10-02:
 * cleared "via D, B7, A" to A's runway 08 hold, pushed back facing the other way and taxied a
 * different route to the same hold, with the line pointing back along D the whole time.
 *
 * Starting values, tuned against that flight's replay (taxiReroute.test.ts):
 * - off the line: more than REROUTE_DISTANCE_M from it (a taxiway is ~23 m wide);
 * - or going the wrong way along it: heading more than WRONG_WAY_DEG off the line's direction;
 * - either one continuously for REROUTE_AFTER_MS while moving faster than
 *   REROUTE_MIN_SPEED_MS, so cutting a corner or a pause doesn't trigger it;
 * - at most one re-route per REROUTE_MIN_INTERVAL_MS, so a bad position can't make the line
 *   flicker.
 *
 * The first re-route rejoins ATC's cleared taxiways where it can (decided 2026-10-02). If the
 * pilot leaves that line too, within REROUTE_ESCALATE_MS, the next one is `direct`: the
 * shortest way to the same end. Without that, flight 227's replay re-routed 13 times, every
 * 10 s, each time pointing back east to D while the pilot taxied west to the same hold.
 */
export const REROUTE_DISTANCE_M = 40
export const REROUTE_AFTER_MS = 5_000
export const REROUTE_MIN_INTERVAL_MS = 10_000
export const REROUTE_MIN_SPEED_MS = 1.03 // ~2 kt
export const REROUTE_ESCALATE_MS = 60_000
/** Within this of the line, a segment counts as driven, for `fromStage`. */
export const STAGE_REACHED_DISTANCE_M = 30

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

export interface DeviationResult {
  reroute: boolean
  /** Re-route by the shortest way rather than back to the cleared taxiways. */
  direct: boolean
  state: DeviationState
}

export function checkDeviation(state: DeviationState, sample: DeviationSample): DeviationResult {
  const moving = sample.groundSpeedMs > REROUTE_MIN_SPEED_MS
  const offLine = sample.distanceM > REROUTE_DISTANCE_M
  const wrongWay =
    !offLine && sample.lineBearingDeg !== null && angleBetweenDeg(sample.headingDeg, sample.lineBearingDeg) > WRONG_WAY_DEG
  if (!moving || !(offLine || wrongWay)) return { reroute: false, direct: false, state: { ...state, deviatingSince: null } }

  const since = state.deviatingSince ?? sample.nowMs
  const longEnough = sample.nowMs - since >= REROUTE_AFTER_MS
  const intervalOk = state.lastRerouteAt === null || sample.nowMs - state.lastRerouteAt >= REROUTE_MIN_INTERVAL_MS
  if (longEnough && intervalOk) {
    const direct = state.lastRerouteAt !== null && sample.nowMs - state.lastRerouteAt <= REROUTE_ESCALATE_MS
    return { reroute: true, direct, state: { deviatingSince: null, lastRerouteAt: sample.nowMs } }
  }
  return { reroute: false, direct: false, state: { ...state, deviatingSince: since } }
}

/** The furthest stage the aircraft has got to: the stage at the start of the segment it's on,
 *  once it's within STAGE_REACHED_DISTANCE_M of it. Never goes back. */
export function stageReached(stages: number[], remaining: RemainingRoute, current: number): number {
  if (remaining.distanceM > STAGE_REACHED_DISTANCE_M) return current
  return Math.max(current, stages[remaining.segment] ?? -1)
}

/** Whether the aircraft has got to the end of the line (the hold, or the stand). From then on
 *  the clearance is done and nothing re-routes: lining up past the hold isn't a deviation. */
export function reachedEnd(route: [number, number][], position: { lat: number; lon: number }): boolean {
  const end = route.at(-1)
  if (!end) return false
  const cosLat = Math.cos((position.lat * Math.PI) / 180)
  const distanceM = Math.hypot((end[1] - position.lat) * 111_320, (end[0] - position.lon) * 111_320 * cosLat)
  return distanceM <= STAGE_REACHED_DISTANCE_M
}
