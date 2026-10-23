/**
 * The worker thread that runs taxi traces (worker-trace-runner.ts). It keeps the last few airports' taxi networks it was sent, so a job
 * names its network instead of carrying 16,000 segments every time.
 */

import { parentPort } from 'node:worker_threads'
import type { NavdataTaxiSegment } from '@shared/ipc'
import { traceClearanceDetailed } from '@shared/taxi/clearance'
import type { WorkerReply, WorkerRequest } from './worker-protocol'

/** How many networks the worker keeps. */
const KEPT_NETWORKS = 4

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
      const { clearance, stand, threshold, holdShortRunway } = request.job
      return {
        id: request.id,
        result: traceClearanceDetailed(clearance, segments, stand, threshold, holdShortRunway)
      }
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
