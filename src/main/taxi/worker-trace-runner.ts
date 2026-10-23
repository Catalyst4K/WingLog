/**
 * Runs the taxi line's traces and re-routes on a worker thread so a slow one (seconds, on the largest airports) never holds up the main
 * process, which also talks to the sim. If the worker cannot start or dies, the job fails and the caller traces it itself: a worker is only ever a
 * way to be faster to respond, never a way to get no line.
 */

import type { NavdataTaxiSegment } from '@shared/ipc'
import type { TracedClearance } from '@shared/taxi/fallback'
import type { RejoinRequest } from '@shared/taxi/route-rejoin'
import type { TracedRoute } from '@shared/taxi/route-types'
import type { TraceJob } from './trace-runner'
import type { WorkerJob, WorkerReply, WorkerRequest } from './worker-protocol'

/** The part of a worker thread this runner uses (a `worker_threads` Worker, or a stand-in in tests). */
export interface WorkerLike {
  postMessage(message: WorkerRequest): void
  on(event: 'message', listener: (reply: WorkerReply) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  terminate(): Promise<unknown>
}

/** Where the runner writes what it does. */
export interface RunnerLog {
  info(message: string): void
  warn(message: string, error?: unknown): void
}

/** After this many workers in a row die before answering anything, no more are started: every job goes to the caller to trace itself. */
const MAX_FAILURES = 3

/** What a job is sent as: its network, and the rest. */
interface Sent {
  segments: NavdataTaxiSegment[]
  job: WorkerJob
}

interface Pending {
  resolve(result: TracedClearance | TracedRoute | null): void
  reject(error: Error): void
  /** The job, kept to send again when the worker says it was never sent the network. */
  sent: Sent
}

/** Traces jobs on a worker thread, started when the first one needs it. */
export class WorkerTraceRunner {
  private worker: WorkerLike | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly networkKeys = new WeakMap<NavdataTaxiSegment[], number>()
  private nextNetworkKey = 1
  /** Which networks the current worker has been sent. */
  private sent = new Set<number>()
  private failures = 0
  private stopped = false

  /**
   * @param create Makes a worker thread.
   * @param log Where to write what happens.
   */
  constructor(
    private readonly create: () => WorkerLike,
    private readonly log: RunnerLog
  ) {}

  /**
   * @param job A clearance to trace.
   * @returns The traced clearance, or a rejection when the worker could not do it.
   */
  run(job: TraceJob): Promise<TracedClearance | null> {
    const { segments, ...rest } = job
    return this.submit({ segments, job: { kind: 'trace', ...rest } }) as Promise<TracedClearance | null>
  }

  /**
   * @param request A line to re-route.
   * @returns The re-routed line, or a rejection when the worker could not do it.
   */
  rejoin(request: RejoinRequest): Promise<TracedRoute | null> {
    const { segments, ...rest } = request
    return this.submit({ segments, job: { kind: 'rejoin', ...rest } }) as Promise<TracedRoute | null>
  }

  /**
   * @param sent A job and its network.
   * @returns The worker's answer, or a rejection when it could not give one.
   */
  private submit(sent: Sent): Promise<TracedClearance | TracedRoute | null> {
    if (this.stopped || this.failures >= MAX_FAILURES) return Promise.reject(new Error('no trace worker'))
    let worker: WorkerLike
    try {
      worker = this.worker ?? this.start()
    } catch (error) {
      this.failures += 1
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, { resolve, reject, sent })
      this.send(worker, id, sent, false)
    })
  }

  /** Starts the worker now, so the first trace does not wait for it. A failure to start is counted and the first job finds out. */
  warm(): void {
    if (this.worker || this.stopped || this.failures >= MAX_FAILURES) return
    try {
      this.start()
    } catch (error) {
      this.failures += 1
      this.log.warn('[taxi] the trace worker could not start:', error)
    }
  }

  /** Ends the worker. */
  stop(): void {
    this.stopped = true
    this.drop(new Error('trace worker stopped'))
  }

  private send(worker: WorkerLike, id: number, { segments, job }: Sent, resendNetwork: boolean): void {
    let key = this.networkKeys.get(segments)
    if (key === undefined) {
      key = this.nextNetworkKey++
      this.networkKeys.set(segments, key)
    }
    const needsNetwork = resendNetwork || !this.sent.has(key)
    if (needsNetwork) this.sent.add(key)
    worker.postMessage({ id, networkKey: key, ...(needsNetwork ? { segments } : {}), job })
  }

  private start(): WorkerLike {
    const worker = this.create()
    this.worker = worker
    this.sent = new Set()
    worker.on('message', (reply) => this.onReply(reply))
    worker.on('error', (error) => this.onFailure(worker, error))
    worker.on('exit', (code) => this.onFailure(worker, new Error(`trace worker exited with code ${code}`)))
    return worker
  }

  private onReply(reply: WorkerReply): void {
    if ('ready' in reply) {
      this.failures = 0
      this.log.info('[taxi] trace worker ready')
      return
    }
    const entry = this.pending.get(reply.id)
    if (!entry) return
    if ('missingNetwork' in reply) {
      // The worker dropped that network to make room: send it again with this job.
      if (this.worker) this.send(this.worker, reply.id, entry.sent, true)
      return
    }
    this.pending.delete(reply.id)
    if ('error' in reply) entry.reject(new Error(reply.error))
    else entry.resolve(reply.result)
  }

  /**
   * @param worker The worker that failed.
   * @param error Why.
   */
  private onFailure(worker: WorkerLike, error: Error): void {
    if (worker !== this.worker) return
    this.failures += 1
    this.log.warn(`[taxi] the trace worker failed (${this.failures} of ${MAX_FAILURES}):`, error)
    this.drop(error)
  }

  /** @param error Why every job waiting is given up. */
  private drop(error: Error): void {
    const worker = this.worker
    this.worker = null
    this.sent = new Set()
    if (worker) worker.terminate().catch(() => undefined) // already gone, or going: nothing left to end
    for (const entry of this.pending.values()) entry.reject(error)
    this.pending.clear()
  }
}
