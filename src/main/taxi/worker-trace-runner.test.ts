import { describe, expect, it, vi } from 'vitest'
import type { NavdataTaxiSegment } from '@shared/ipc'
import type { TracedClearance } from '@shared/taxi/fallback'
import type { TraceJob } from './trace-runner'
import type { WorkerReply, WorkerRequest } from './worker-protocol'
import { WorkerTraceRunner, type WorkerLike } from './worker-trace-runner'

/** A worker the test answers by hand. */
class FakeWorker implements WorkerLike {
  requests: WorkerRequest[] = []
  terminated = false
  private readonly listeners: {
    message: ((r: WorkerReply) => void)[]
    error: ((e: Error) => void)[]
    exit: ((c: number) => void)[]
  } = {
    message: [],
    error: [],
    exit: []
  }
  postMessage(message: WorkerRequest): void {
    this.requests.push(message)
  }
  on(event: 'message' | 'error' | 'exit', listener: never): this {
    ;(this.listeners[event] as unknown[]).push(listener)
    return this
  }
  terminate(): Promise<number> {
    this.terminated = true
    return Promise.resolve(0)
  }
  reply(reply: WorkerReply): void {
    this.listeners.message.forEach((l) => l(reply))
  }
  fail(error: Error): void {
    this.listeners.error.forEach((l) => l(error))
  }
  exit(code: number): void {
    this.listeners.exit.forEach((l) => l(code))
  }
}

const SEGMENTS: NavdataTaxiSegment[] = [
  { startLat: 1, startLon: 2, endLat: 1, endLon: 3, name: 'A', startHoldShort: false, endHoldShort: false }
]
const job = (segments: NavdataTaxiSegment[] = SEGMENTS): TraceJob => ({
  clearance: { taxiways: ['A'], holdingPoint: null, stand: null, holdShortRunway: null, from: null },
  segments,
  stand: null,
  threshold: null,
  holdShortRunway: null
})
const TRACED = {
  route: [[2, 1]],
  kind: 'exact',
  problems: [],
  exactProblems: null
} as unknown as TracedClearance

function setup() {
  const workers: FakeWorker[] = []
  const log = { info: vi.fn(), warn: vi.fn() }
  const runner = new WorkerTraceRunner(() => {
    const w = new FakeWorker()
    workers.push(w)
    return w
  }, log)
  return { runner, workers, log }
}

describe('WorkerTraceRunner', () => {
  it('starts the worker on the first job and sends the network once, then jobs for it by key', async () => {
    const { runner, workers } = setup()
    expect(workers).toHaveLength(0)
    const first = runner.run(job())
    const [worker] = workers
    expect(worker.requests[0]).toMatchObject({ id: 1, segments: SEGMENTS, job: { kind: 'trace' } })
    worker.reply({ id: 1, result: TRACED })
    await expect(first).resolves.toEqual(TRACED)

    const second = runner.run(job())
    expect(worker.requests[1].segments).toBeUndefined()
    expect(worker.requests[1].networkKey).toBe(worker.requests[0].networkKey)
    worker.reply({ id: 2, result: null })
    await expect(second).resolves.toBeNull()
    expect(workers).toHaveLength(1)
  })

  it('sends another network, with its segments, under another key', () => {
    const { runner, workers } = setup()
    void runner.run(job()).catch(() => undefined)
    const other = [{ ...SEGMENTS[0], name: 'B' }]
    void runner.run(job(other)).catch(() => undefined)
    const [a, b] = workers[0].requests
    expect(b.networkKey).not.toBe(a.networkKey)
    expect(b.segments).toEqual(other)
  })

  it('rejects a job the worker answered with an error, and keeps the worker for the next', async () => {
    const { runner, workers } = setup()
    const failed = runner.run(job())
    workers[0].reply({ id: 1, error: 'bad clearance' })
    await expect(failed).rejects.toThrow('bad clearance')
    void runner.run(job())
    expect(workers).toHaveLength(1)
  })

  it('sends the network again when the worker says it dropped it', async () => {
    const { runner, workers } = setup()
    const result = runner.run(job())
    workers[0].reply({ id: 1, missingNetwork: true })
    expect(workers[0].requests).toHaveLength(2)
    expect(workers[0].requests[1]).toMatchObject({ id: 1, segments: SEGMENTS })
    workers[0].reply({ id: 1, result: TRACED })
    await expect(result).resolves.toEqual(TRACED)
  })

  it('gives up the jobs waiting when the worker dies, ends it, and starts a new one for the next job, sending the network afresh', async () => {
    const { runner, workers, log } = setup()
    const waiting = runner.run(job())
    workers[0].fail(new Error('out of memory'))
    await expect(waiting).rejects.toThrow('out of memory')
    expect(workers[0].terminated).toBe(true)
    expect(log.warn).toHaveBeenCalledOnce()

    void runner.run(job())
    expect(workers).toHaveLength(2)
    expect(workers[1].requests[0].segments).toEqual(SEGMENTS)
  })

  it('treats an exit as a failure too, and ignores a failure of a worker it has already dropped', async () => {
    const { runner, workers, log } = setup()
    const waiting = runner.run(job())
    workers[0].exit(1)
    await expect(waiting).rejects.toThrow('exited with code 1')
    workers[0].fail(new Error('late'))
    expect(log.warn).toHaveBeenCalledOnce()
  })

  it('stops starting workers after three in a row die without ever becoming ready', async () => {
    const { runner, workers } = setup()
    for (let i = 0; i < 3; i++) {
      const waiting = runner.run(job())
      workers[i].fail(new Error('no'))
      await expect(waiting).rejects.toThrow('no')
    }
    await expect(runner.run(job())).rejects.toThrow('no trace worker')
    expect(workers).toHaveLength(3)
  })

  it('counts a worker that became ready as working: its later failure starts the count again', async () => {
    const { runner, workers, log } = setup()
    for (let i = 0; i < 4; i++) {
      const waiting = runner.run(job())
      workers[i].reply({ ready: true })
      workers[i].fail(new Error('later'))
      await expect(waiting).rejects.toThrow('later')
    }
    expect(workers).toHaveLength(4)
    expect(log.info).toHaveBeenCalledWith('[taxi] trace worker ready')
  })

  it('rejects when no worker can be made, and counts it', async () => {
    const log = { info: vi.fn(), warn: vi.fn() }
    const create = vi.fn(() => {
      throw new Error('no worker file')
    })
    const runner = new WorkerTraceRunner(create, log)
    await expect(runner.run(job())).rejects.toThrow('no worker file')
    await expect(runner.run(job())).rejects.toThrow('no worker file')
    await expect(runner.run(job())).rejects.toThrow('no worker file')
    await expect(runner.run(job())).rejects.toThrow('no trace worker')
    expect(create).toHaveBeenCalledTimes(3)
  })

  it('stop() ends the worker, gives up the jobs waiting, and refuses later ones', async () => {
    const { runner, workers } = setup()
    const waiting = runner.run(job())
    runner.stop()
    await expect(waiting).rejects.toThrow('stopped')
    expect(workers[0].terminated).toBe(true)
    await expect(runner.run(job())).rejects.toThrow('no trace worker')
  })

  it('re-routes on the same worker, naming a network a trace already sent by its key, and sends it again when dropped', async () => {
    const { runner, workers } = setup()
    void runner.run(job()).catch(() => undefined)
    const line: [number, number][] = [
      [2, 1],
      [3, 1]
    ]
    const rerouted = runner.rejoin({
      segments: SEGMENTS,
      route: line,
      fromSegment: 0,
      from: { lat: 1, lon: 2 },
      headingDeg: 90
    })
    const [worker] = workers
    expect(workers).toHaveLength(1)
    expect(worker.requests[1]).toEqual({
      id: 2,
      networkKey: worker.requests[0].networkKey,
      job: { kind: 'rejoin', route: line, fromSegment: 0, from: { lat: 1, lon: 2 }, headingDeg: 90 }
    })
    worker.reply({ id: 2, missingNetwork: true })
    expect(worker.requests[2]).toMatchObject({ id: 2, segments: SEGMENTS, job: { kind: 'rejoin' } })
    worker.reply({ id: 2, result: line })
    await expect(rerouted).resolves.toEqual(line)
  })

  it('rejects a re-route when the worker dies, as it does a trace', async () => {
    const { runner, workers } = setup()
    const rerouted = runner.rejoin({
      segments: SEGMENTS,
      route: [],
      fromSegment: 0,
      from: { lat: 1, lon: 2 }
    })
    workers[0].fail(new Error('out of memory'))
    await expect(rerouted).rejects.toThrow('out of memory')
  })

  it('ignores an answer for a job it no longer waits for', () => {
    const { runner, workers } = setup()
    void runner.run(job()).catch(() => undefined)
    expect(() => workers[0].reply({ id: 99, result: TRACED })).not.toThrow()
  })

  it('warm() starts the worker before any job, once, and does nothing after stop() or when none can be made', () => {
    const { runner, workers } = setup()
    runner.warm()
    runner.warm()
    expect(workers).toHaveLength(1)
    void runner.run(job()).catch(() => undefined)
    expect(workers).toHaveLength(1)
    expect(workers[0].requests[0].segments).toEqual(SEGMENTS)
    runner.stop()
    runner.warm()
    expect(workers).toHaveLength(1)

    const log = { info: vi.fn(), warn: vi.fn() }
    const broken = new WorkerTraceRunner(() => {
      throw new Error('no worker file')
    }, log)
    broken.warm()
    expect(log.warn).toHaveBeenCalledWith('[taxi] the trace worker could not start:', expect.any(Error))
  })
})
