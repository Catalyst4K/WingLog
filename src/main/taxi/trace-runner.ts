/**
 * How the taxi line service has a clearance traced, and a line re-routed. Both are searches that take milliseconds on most airports and
 * seconds (the trace: RKSI's worst measured 3.3 s) or most of one (a re-route: 0.6 s) on the largest, in the process that also talks to
 * the sim, so the app runs them on a worker thread (worker-trace-runner.ts). Tests and the offline sims run them inline.
 */

import type { NavdataStand, NavdataTaxiSegment } from '@shared/ipc'
import { traceClearanceDetailed, type TaxiClearance } from '@shared/taxi/clearance'
import type { TracedClearance } from '@shared/taxi/fallback'
import { rejoinTaxiRoute, type RejoinRequest } from '@shared/taxi/route-rejoin'
import type { RunwayStrip, TracedRoute } from '@shared/taxi/route-types'
import type { RunwayThreshold } from '@shared/taxi/runway-hold'

/** Everything one trace needs: plain data, so it can be sent to a worker. */
export interface TraceJob {
  clearance: TaxiClearance
  /** The airport's taxi network. The same array (by identity) is the same network: a worker keeps it between jobs. */
  segments: NavdataTaxiSegment[]
  stand: NavdataStand | null
  threshold: RunwayThreshold | null
  holdShortRunway: RunwayStrip | null
}

/** Traces a job: the answer at once, or a promise of it. */
export type TraceRunner = (job: TraceJob) => TracedClearance | null | Promise<TracedClearance | null>

/**
 * @param job The clearance and what it ends at.
 * @returns The traced clearance, worked out on this thread.
 */
export const traceInline: TraceRunner = (job) =>
  traceClearanceDetailed(job.clearance, job.segments, job.stand, job.threshold, job.holdShortRunway)

/** Re-routes a line (a RejoinRequest is plain data too, and names its network the same way): the answer at once, or a promise of it. */
export type RejoinRunner = (request: RejoinRequest) => TracedRoute | null | Promise<TracedRoute | null>

/**
 * @param request Where the aircraft is and the route to rejoin.
 * @returns The re-routed line, worked out on this thread.
 */
export const rejoinInline: RejoinRunner = (request) => rejoinTaxiRoute(request)
