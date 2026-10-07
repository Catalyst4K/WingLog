/** When and how a traced taxi line is re-traced from where the aircraft is. */

import type { FlightPhase, NavdataTaxiSegment } from '@shared/ipc'
import {
  angleBetweenDeg,
  rejoinTaxiRoute,
  remainingRoute,
  WRONG_WAY_DEG,
  type RemainingRoute,
  type TracedRoute
} from './taxi-route-trace'
import { flatDistanceM } from '@shared/geo'

/**
 * When the traced taxi line should be re-traced from where the aircraft is
 * (winglog-backend's docs/plans/taxi-reroute.md). Real case, ZJSY flight 227, 2026-10-02:
 * cleared "via D, B7, A" to A's runway 08 hold, pushed back facing the other way and taxied a
 * different route to the same hold, with the line pointing back along D the whole time.
 * Where a re-route goes is taxi-route-trace.ts's rejoinTaxiRoute: the shortest total way to the
 * same end, joining the cleared route wherever that's shortest.
 *
 * Starting values, checked against that flight's replay (taxi-reroute.test.ts):
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
  if (!moving || !(offLine || wrongWay)) return { reroute: false, state: { ...state, deviatingSince: null } }

  const since = state.deviatingSince ?? sample.nowMs
  const longEnough = sample.nowMs - since >= REROUTE_AFTER_MS
  const intervalOk =
    state.lastRerouteAt === null || sample.nowMs - state.lastRerouteAt >= REROUTE_MIN_INTERVAL_MS
  if (longEnough && intervalOk)
    return { reroute: true, state: { deviatingSince: null, lastRerouteAt: sample.nowMs } }
  return { reroute: false, state: { ...state, deviatingSince: since } }
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
}

/**
 * Starts tracking a newly traced clearance.
 *
 * @param cleared The traced clearance.
 * @returns The tracker.
 */
export function startTracker(cleared: TracedRoute): RerouteTracker {
  return { cleared, active: cleared, progress: 0, driven: 0, deviation: INITIAL_DEVIATION, done: false }
}

export interface TrackerUpdate {
  position: { lat: number; lon: number; headingDeg?: number; groundSpeedMs?: number }
  phase: FlightPhase | null
  nowMs: number
  segments: NavdataTaxiSegment[] | undefined
}

/**
 * One position update: what's left of the line to draw, re-routing first if the aircraft
 * has left it (useTaxiRouteHighlight calls this on every update; the offline simulation of
 * real flights calls exactly the same thing). Only re-routes while taxiing: a pushback
 * drives tail first, so its heading is backwards.
 *
 * @param tracker The tracker.
 * @param update The position, phase, time and taxi network.
 * @returns The new tracker, the line to draw, and whether it re-routed.
 */
export function trackPosition(
  tracker: RerouteTracker,
  { position, phase, nowMs, segments }: TrackerUpdate
): { tracker: RerouteTracker; line: TracedRoute; rerouted: boolean } {
  let { active } = tracker
  let remaining = remainingRoute(active, position, tracker.progress)
  const driven = segmentDriven(remainingRoute(tracker.cleared, position, tracker.driven), tracker.driven)
  const done = tracker.done || reachedEnd(active, position)
  let deviation = tracker.deviation
  let rerouted = false
  const { headingDeg, groundSpeedMs } = position
  if (phase === 'taxi' && !done && segments && headingDeg !== undefined && groundSpeedMs !== undefined) {
    const check = checkDeviation(deviation, {
      nowMs,
      distanceM: remaining.distanceM,
      lineBearingDeg: remaining.bearingDeg,
      headingDeg,
      groundSpeedMs
    })
    deviation = check.state
    if (check.reroute) {
      const next = rejoinTaxiRoute({
        segments,
        route: tracker.cleared,
        fromSegment: driven,
        from: { lat: position.lat, lon: position.lon },
        headingDeg
      })
      if (next) {
        active = next
        remaining = remainingRoute(next, position, 0)
        rerouted = true
      }
    }
  }
  return {
    tracker: { cleared: tracker.cleared, active, progress: remaining.segment, driven, deviation, done },
    line: remaining.line,
    rerouted
  }
}
