/** The messages between the taxi line service's worker runner and its worker thread. */

import type { NavdataTaxiSegment } from '@shared/ipc'
import type { TracedClearance } from '@shared/taxi/fallback'
import type { TraceJob } from './trace-runner'

/** A job for the worker: the network by key, with its segments the first time the worker is sent that key. */
export interface WorkerRequest {
  id: number
  networkKey: number
  segments?: NavdataTaxiSegment[]
  job: Omit<TraceJob, 'segments'>
}

/** What the worker answers: the traced clearance (null for none), the network it was never sent, or an error. */
export type WorkerReply =
  | { ready: true }
  | { id: number; result: TracedClearance | null }
  | { id: number; missingNetwork: true }
  | { id: number; error: string }
