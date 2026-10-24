/**
 * The worker thread that runs taxi traces and re-routes (worker-trace-runner.ts). It keeps the last few airports' taxi networks it was sent, so a job
 * names its network instead of carrying 16,000 segments every time.
 */

import { parentPort } from 'node:worker_threads'
import type { NavdataTaxiSegment } from '@shared/ipc'
import { traceClearanceDetailed } from '@shared/taxi/clearance'
import type { TracedClearance } from '@shared/taxi/fallback'
import { rejoinTaxiRoute } from '@shared/taxi/route-rejoin'
import type { TracedRoute } from '@shared/taxi/route-types'
import type { WorkerJob, WorkerReply, WorkerRequest } from './worker-protocol'

/** How many networks the worker keeps. */
const KEPT_NETWORKS = 4

/**
 * @param job A trace or a re-route.
 * @param segments Its taxi network.
 * @returns The traced clearance, or the re-routed line; null for none.
 */
function answerJob(job: WorkerJob, segments: NavdataTaxiSegment[]): TracedClearance | TracedRoute | null {
  if (job.kind === 'rejoin') {
    const { route, fromSegment, from, headingDeg, holdShortRunway } = job
    return rejoinTaxiRoute({ segments, route, fromSegment, from, headingDeg, holdShortRunway })
  }
  return traceClearanceDetailed(job.clearance, segments, job.stand, job.threshold, job.holdShortRunway)
}

/**
 * @returns A function that answers one request from the main thread, keeping the networks it is sent.
 */
export function createTraceAnswerer(): (request: WorkerRequest) => WorkerReply {
  const networks = new Map<number, NavdataTaxiSegment[]>()
  return (request) => {
    try {
      if (request.segments) {
        networks.delete(request.networkKey)
        networks.set(request.networkKey, request.segments)
        for (const key of networks.keys()) {
          if (networks.size <= KEPT_NETWORKS) break
          networks.delete(key)
        }
      }
      const segments = networks.get(request.networkKey)
      if (!segments) return { id: request.id, missingNetwork: true }
      return { id: request.id, result: answerJob(request.job, segments) }
    } catch (error) {
      return { id: request.id, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

if (parentPort) {
  const port = parentPort
  const answer = createTraceAnswerer()
  port.on('message', (request: WorkerRequest) => port.postMessage(answer(request)))
  port.postMessage({ ready: true } satisfies WorkerReply)
}
