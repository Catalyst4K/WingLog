/** When and how a traced taxi line is re-traced from where the aircraft is. */

import type { FlightPhase, NavdataTaxiSegment } from '@shared/ipc'
import {
  MAX_FOLLOW_DISTANCE_M,
  rejoinTaxiRoute,
  remainingRoute,
  type RejoinRequest,
  type RemainingRoute
} from './route-rejoin'
import { angleBetweenDeg, WRONG_WAY_DEG } from './route-graph'
import { type RunwayStrip, type TracedRoute } from './route-types'
import { flatDistanceM } from '@shared/geo'

/**
 * When the traced taxi line should be re-traced from where the aircraft is
 * (winglog-backend's docs/plans/taxi-reroute.md): an aircraft that pushes back facing the other
 * way and taxis a different route to the same hold would otherwise keep a line pointing back
 * along the cleared route.
 * Where a re-route goes is route-rejoin.ts's rejoinTaxiRoute: the shortest total way to the
 * same end, joining the cleared route wherever that's shortest.
 *
 * Starting values, checked against that flight's replay (taxi-reroute.test.ts):
 * - off the line: more than REROUTE_DISTANCE_M from it (a taxiway is ~23 m wide);
 * - or going the wrong way along it: heading more than WRONG_WAY_DEG off the line's direction;
 * - off the line continuously for REROUTE_AFTER_MS, or going the wrong way along it continuously for the shorter WRONG_WAY_AFTER_MS
 *   (the line points behind the aircraft all that time, and a turn on the spot that ends facing back along the route is not a
 *   corner cut), either while moving faster than REROUTE_MIN_SPEED_MS, so cutting a corner or a pause doesn't trigger it;
 * - or past it: the line's nearest point more than PASSED_DISTANCE_M away and more than WRONG_WAY_DEG off the nose, for
 *   PASSED_AFTER_MS. Driving straight on past the line's turn is neither of the others for a while (still heading along the
 *   taxiway, not yet 40 m away), and meanwhile the line points back at the turn behind: 5 to 16 s at a time over Callum's
 *   recorded taxis (2026-10-22, "some of the routes seem to offer the taxiway behind on reroute");
 * - at most one re-route per REROUTE_MIN_INTERVAL_MS, so a bad position can't make the line
 *   flicker.
 */
export const REROUTE_DISTANCE_M = 40
export const REROUTE_AFTER_MS = 5_000
/** Going the wrong way along the line: the robustness plan's stage 6 found a stop and a 180° turn left the line pointing behind for the full 5 s;
 *  3 s keeps it under that plan's 4 s limit. */
export const WRONG_WAY_AFTER_MS = 3_000
export const REROUTE_MIN_INTERVAL_MS = 10_000
export const REROUTE_MIN_SPEED_MS = 1.03 // ~2 kt
/** Beyond this, the line's nearest point is off the taxiway the aircraft is on (half of a ~23 m taxiway, and some). */
export const PASSED_DISTANCE_M = 15
export const PASSED_AFTER_MS = 2_000
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
  /** The bearing from the aircraft to the line's nearest point; null when on it or unknown. */
  nearestBearingDeg?: number | null
  headingDeg: number
  groundSpeedMs: number
}

/**
 * @param passed Whether the aircraft has driven past the line.
 * @param wrongWay Whether it is going the wrong way along the line.
 * @returns How long the deviation must last before the line is re-routed.
 */
function waitBeforeReroute(passed: boolean, wrongWay: boolean): number {
  if (passed) return PASSED_AFTER_MS
  return wrongWay ? WRONG_WAY_AFTER_MS : REROUTE_AFTER_MS
}

/**
 * Whether the aircraft has left the line for long enough to re-route.
 *
 * @param state The deviation state so far.
 * @param sample This update's distance, heading and speed.
 * @returns Whether to re-route now, and the new state.
 */
export function checkDeviation(
  state: DeviationState,
  sample: DeviationSample
): { reroute: boolean; state: DeviationState } {
  const moving = sample.groundSpeedMs > REROUTE_MIN_SPEED_MS
  const offLine = sample.distanceM > REROUTE_DISTANCE_M
  const wrongWay =
    !offLine &&
    sample.lineBearingDeg !== null &&
    angleBetweenDeg(sample.headingDeg, sample.lineBearingDeg) > WRONG_WAY_DEG
  const passed =
    sample.distanceM > PASSED_DISTANCE_M &&
    sample.nearestBearingDeg !== undefined &&
    sample.nearestBearingDeg !== null &&
    angleBetweenDeg(sample.headingDeg, sample.nearestBearingDeg) > WRONG_WAY_DEG
  if (!moving || !(offLine || wrongWay || passed))
    return { reroute: false, state: { ...state, deviatingSince: null } }

  const since = state.deviatingSince ?? sample.nowMs
  const longEnough = sample.nowMs - since >= waitBeforeReroute(passed, wrongWay)
  const intervalOk =
    state.lastRerouteAt === null || sample.nowMs - state.lastRerouteAt >= REROUTE_MIN_INTERVAL_MS
  if (longEnough && intervalOk)
    return { reroute: true, state: { deviatingSince: null, lastRerouteAt: sample.nowMs } }
  return { reroute: false, state: { ...state, deviatingSince: since } }
}

/**
 * @param remaining The route remaining from the aircraft (remainingRoute), which runs from the aircraft to the line's nearest point.
 * @param position The aircraft's position.
 * @returns The bearing from the aircraft to that point, degrees true; null on the line or too far from it to know the point.
 */
function nearestBearing(remaining: RemainingRoute, position: { lat: number; lon: number }): number | null {
  const point = remaining.line[1]
  if (remaining.distanceM < 0.5 || remaining.distanceM > MAX_FOLLOW_DISTANCE_M || !point) return null
  const [lon, lat] = point
  const dx = (lon - position.lon) * Math.cos((position.lat * Math.PI) / 180)
  return ((Math.atan2(dx, lat - position.lat) * 180) / Math.PI + 360) % 360
}

/**
 * The furthest segment of the cleared route the aircraft has driven: the one it's on, once
 * within DRIVEN_DISTANCE_M of it. Never goes back.
 *
 * @param remaining The route remaining from the aircraft.
 * @param current The furthest segment so far.
 * @returns The furthest segment.
 */
export function segmentDriven(remaining: RemainingRoute, current: number): number {
  return remaining.distanceM > DRIVEN_DISTANCE_M ? current : Math.max(current, remaining.segment)
}

/**
 * Whether the aircraft has got to the end of the line (the hold, or the stand). From then on
 * the clearance is done and nothing re-routes: lining up past the hold isn't a deviation.
 *
 * @param route The line.
 * @param position The aircraft's position.
 * @returns True at the end.
 */
export function reachedEnd(route: [number, number][], position: { lat: number; lon: number }): boolean {
  const end = route.at(-1)
  if (!end) return false
  return flatDistanceM(position, { lat: end[1], lon: end[0] }) <= DRIVEN_DISTANCE_M
}

/** Everything the taxi line needs to remember between position updates, for one clearance. */
export interface RerouteTracker {
  /** The cleared route as first traced: what a re-route rejoins. */
  cleared: TracedRoute
  /** The line being drawn: `cleared`, or its latest re-route. */
  active: TracedRoute
  /** How far along `active` the aircraft has got (remainingRoute's `segment`). */
  progress: number
  /** The furthest segment of `cleared` driven: a re-route only rejoins from there on. */
  driven: number
  deviation: DeviationState
  /** Set once the aircraft reaches the end of the line: the clearance is done. */
  done: boolean
  /** The runway of a "hold short of runway" clearance: a re-route may hold short of it somewhere else (rejoinTaxiRoute). */
  holdShortRunway: RunwayStrip | null
}

/**
 * Starts tracking a newly traced clearance.
 *
 * @param cleared The traced clearance.
 * @param holdShortRunway The runway of a "hold short of runway" clearance, or null.
 * @returns The tracker.
 */
export function startTracker(
  cleared: TracedRoute,
  holdShortRunway: RunwayStrip | null = null
): RerouteTracker {
  return {
    cleared,
    active: cleared,
    progress: 0,
    driven: 0,
    deviation: INITIAL_DEVIATION,
    done: false,
    holdShortRunway
  }
}

export interface TrackerUpdate {
  position: { lat: number; lon: number; headingDeg?: number; groundSpeedMs?: number }
  phase: FlightPhase | null
  nowMs: number
  segments: NavdataTaxiSegment[] | undefined
}

/**
 * One position update, without the re-route search: what's left of the line to draw, and the re-route to search for when the aircraft
 * has left it. The app sends that search to its worker thread and applies the answer with applyReroute; trackPosition does both at once.
 * Only re-routes while taxiing: a pushback drives tail first, so its heading is backwards.
 *
 * @param tracker The tracker.
 * @param update The position, phase, time and taxi network.
 * @returns The new tracker, the line to draw, and the re-route to search for (null when none is due).
 */
export function followPosition(
  tracker: RerouteTracker,
  { position, phase, nowMs, segments }: TrackerUpdate
): { tracker: RerouteTracker; line: TracedRoute; reroute: RejoinRequest | null } {
  const remaining = remainingRoute(tracker.active, position, tracker.progress)
  const driven = segmentDriven(remainingRoute(tracker.cleared, position, tracker.driven), tracker.driven)
  const done = tracker.done || reachedEnd(tracker.active, position)
  let deviation = tracker.deviation
  let reroute: RejoinRequest | null = null
  const { headingDeg, groundSpeedMs } = position
  if (phase === 'taxi' && !done && segments && headingDeg !== undefined && groundSpeedMs !== undefined) {
    const check = checkDeviation(deviation, {
      nowMs,
      distanceM: remaining.distanceM,
      lineBearingDeg: remaining.bearingDeg,
      nearestBearingDeg: nearestBearing(remaining, position),
      headingDeg,
      groundSpeedMs
    })
    deviation = check.state
    if (check.reroute)
      reroute = {
        segments,
        route: tracker.cleared,
        fromSegment: driven,
        from: { lat: position.lat, lon: position.lon },
        headingDeg,
        holdShortRunway: tracker.holdShortRunway
      }
  }
  return {
    tracker: { ...tracker, progress: remaining.segment, driven, deviation, done },
    line: remaining.line,
    reroute
  }
}

/**
 * Takes a re-routed line as the one drawn, from where the aircraft is now.
 *
 * @param tracker The tracker.
 * @param next The re-routed line (rejoinTaxiRoute's answer).
 * @param position The aircraft's position.
 * @returns The new tracker and the line to draw.
 */
export function applyReroute(
  tracker: RerouteTracker,
  next: TracedRoute,
  position: { lat: number; lon: number }
): { tracker: RerouteTracker; line: TracedRoute } {
  const remaining = remainingRoute(next, position, 0)
  return { tracker: { ...tracker, active: next, progress: remaining.segment }, line: remaining.line }
}

/**
 * One position update: what's left of the line to draw, re-routing first if the aircraft has left it (followPosition, then the
 * re-route search and applyReroute in the same call). The offline simulations of real flights call this.
 *
 * @param tracker The tracker.
 * @param update The position, phase, time and taxi network.
 * @returns The new tracker, the line to draw, and whether it re-routed.
 */
export function trackPosition(
  tracker: RerouteTracker,
  update: TrackerUpdate
): { tracker: RerouteTracker; line: TracedRoute; rerouted: boolean } {
  const followed = followPosition(tracker, update)
  const next = followed.reroute && rejoinTaxiRoute(followed.reroute)
  if (!next) return { tracker: followed.tracker, line: followed.line, rerouted: false }
  return { ...applyReroute(followed.tracker, next, update.position), rerouted: true }
}
