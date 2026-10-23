/**
 * How the taxi line service has a clearance traced. The trace is a search that takes tens of milliseconds on most airports and seconds on
 * the largest (RKSI's worst measured 3.3 s), in the process that also talks to the sim, so the app runs it on a worker thread
 * (worker-trace-runner.ts). Tests and the offline sims run it inline.
 */

import type { NavdataStand, NavdataTaxiSegment } from '@shared/ipc'
import { traceClearanceDetailed, type TaxiClearance } from '@shared/taxi/clearance'
import type { TracedClearance } from '@shared/taxi/fallback'
import type { RunwayStrip } from '@shared/taxi/route-types'
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
