/** The messages between the taxi line service's worker runner and its worker thread. */

import type { NavdataTaxiSegment } from '@shared/ipc'
import type { TracedClearance } from '@shared/taxi/fallback'
import type { RejoinRequest } from '@shared/taxi/route-rejoin'
import type { TracedRoute } from '@shared/taxi/route-types'
import type { TraceJob } from './trace-runner'

/** A job without its network, which travels by key: a clearance to trace, or a line to re-route. */
export type WorkerJob =
  ({ kind: 'trace' } & Omit<TraceJob, 'segments'>) | ({ kind: 'rejoin' } & Omit<RejoinRequest, 'segments'>)

/** A job for the worker: the network by key, with its segments the first time the worker is sent that key. */
export interface WorkerRequest {
  id: number
  networkKey: number
  segments?: NavdataTaxiSegment[]
  job: WorkerJob
}

/** What the worker answers: the traced clearance or re-routed line (null for none), the network it was never sent, or an error. */
export type WorkerReply =
  | { ready: true }
  | { id: number; result: TracedClearance | TracedRoute | null }
  | { id: number; missingNetwork: true }
  | { id: number; error: string }
