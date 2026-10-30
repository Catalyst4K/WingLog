import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SimTraffic } from '@shared/ipc'
import type { SimTrafficRecord } from '../sim/simvars'
import {
  SIM_RETRY_MS,
  SIM_SWEEP_INTERVAL_MS,
  SimTrafficService,
  type SimTrafficHandlers,
  type SimTrafficLink
} from './SimTrafficService'

/** Timers that only run when told to. */
class FakeTimers {
  private next = 1
  private pending = new Map<number, { at: number; callback: () => void }>()
  nowMs = 0
  set = (callback: () => void, ms: number): number => {
    const id = this.next++
    this.pending.set(id, { at: this.nowMs + ms, callback })
    return id
  }
  clear = (handle: unknown): void => {
    this.pending.delete(handle as number)
  }
  get count(): number {
    return this.pending.size
  }
  advance(ms: number): void {
    const until = this.nowMs + ms
    for (;;) {
      const due = [...this.pending.entries()]
        .filter(([, t]) => t.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      this.pending.delete(due[0])
      this.nowMs = due[1].at
      due[1].callback()
    }
    this.nowMs = until
  }
}

const record = (objectId: number, overrides: Partial<SimTrafficRecord> = {}): SimTrafficRecord => ({
  objectId,
  latitude: 33.94,
  longitude: -118.41,
  altitudeM: 100,
  headingDeg: 90,
  groundSpeedMs: 10,
  onGround: true,
  atcId: `UAL${objectId}`,
  title: 'FSLTL_B738',
  ...overrides
})

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('SimTrafficService', () => {
  let timers: FakeTimers
  let published: SimTraffic[]
  let handlers: SimTrafficHandlers[]
  let links: { requestSweep: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[]
  let openResult: 'ok' | 'fail'
  let service: SimTrafficService

  beforeEach(() => {
    timers = new FakeTimers()
    published = []
    handlers = []
    links = []
    openResult = 'ok'
    service = new SimTrafficService({
      hub: { publish: ((_topic: string, payload: SimTraffic) => published.push(payload)) as never },
      open: (h) => {
        handlers.push(h)
        if (openResult === 'fail') return Promise.reject(new Error('no sim'))
        const link = { requestSweep: vi.fn(), close: vi.fn() }
        links.push(link)
        return Promise.resolve(link as SimTrafficLink)
      },
      timers,
      log: { warn: vi.fn() }
    })
  })

  it('starts off, opens nothing, and says so once', () => {
    service.start()
    service.setWanted(false)
    expect(published).toEqual([{ state: 'off', aircraft: [] }])
    expect(handlers).toHaveLength(0)
  })

  it('opens a connection when wanted, asks for a sweep at once and every 5 s', async () => {
    service.start()
    service.setWanted(true)
    await flush()
    expect(links).toHaveLength(1)
    expect(links[0].requestSweep).toHaveBeenCalledTimes(1)
    timers.advance(SIM_SWEEP_INTERVAL_MS)
    expect(links[0].requestSweep).toHaveBeenCalledTimes(2)
    timers.advance(SIM_SWEEP_INTERVAL_MS * 2)
    expect(links[0].requestSweep).toHaveBeenCalledTimes(4)
  })

  it("publishes each sweep without the user's own aircraft or scenery", async () => {
    service.start()
    service.setWanted(true)
    await flush()
    handlers[0].onUser(1)
    handlers[0].onSweep([record(1), record(2), record(3, { title: 'ApronLife_Jetway' })])
    expect(published.at(-1)).toMatchObject({ state: 'shown' })
    expect(published.at(-1)?.aircraft.map((a) => a.key)).toEqual(['2'])
  })

  it('closes the connection and clears the layer when no longer wanted', async () => {
    service.start()
    service.setWanted(true)
    await flush()
    service.setWanted(false)
    expect(links[0].close).toHaveBeenCalled()
    expect(published.at(-1)).toEqual({ state: 'off', aircraft: [] })
    expect(timers.count).toBe(0)
    timers.advance(60_000)
    expect(links[0].requestSweep).toHaveBeenCalledTimes(1)
  })

  it('says the sim is unavailable once when it cannot be opened, and tries again later', async () => {
    openResult = 'fail'
    service.start()
    service.setWanted(true)
    await flush()
    expect(published.at(-1)).toEqual({ state: 'unavailable', aircraft: [] })
    openResult = 'ok'
    timers.advance(SIM_RETRY_MS)
    await flush()
    expect(links).toHaveLength(1)
    expect(links[0].requestSweep).toHaveBeenCalled()
  })

  it('does not repeat "unavailable" while the sim stays away', async () => {
    openResult = 'fail'
    service.start()
    service.setWanted(true)
    await flush()
    timers.advance(SIM_RETRY_MS)
    await flush()
    timers.advance(SIM_RETRY_MS)
    await flush()
    expect(published.filter((p) => p.state === 'unavailable')).toHaveLength(1)
  })

  it('goes unavailable when the sim quits and reconnects when it is back', async () => {
    service.start()
    service.setWanted(true)
    await flush()
    handlers[0].onLost()
    expect(published.at(-1)?.state).toBe('unavailable')
    expect(links[0].close).toHaveBeenCalled()
    timers.advance(SIM_RETRY_MS)
    await flush()
    expect(links).toHaveLength(2)
  })

  it('closes a connection that opens after it was no longer wanted', async () => {
    service.start()
    service.setWanted(true)
    service.setWanted(false)
    await flush()
    expect(links[0].close).toHaveBeenCalled()
    expect(links[0].requestSweep).not.toHaveBeenCalled()
  })

  it('ignores a sweep or a drop from a connection it has already closed', async () => {
    service.start()
    service.setWanted(true)
    await flush()
    const old = handlers[0]
    service.setWanted(false)
    const before = published.length
    old.onSweep([record(2)])
    old.onUser(9)
    old.onLost()
    expect(published).toHaveLength(before)
    expect(timers.count).toBe(0)
  })

  it('ignores a failed open from a closed attempt, and does nothing after stop', async () => {
    openResult = 'fail'
    service.start()
    service.setWanted(true)
    service.setWanted(false)
    await flush()
    expect(timers.count).toBe(0)
    service.stop()
    service.setWanted(true)
    expect(handlers).toHaveLength(1)
  })

  it('survives a link that throws on close', async () => {
    service.start()
    service.setWanted(true)
    await flush()
    links[0].close.mockImplementation(() => {
      throw new Error('already closed')
    })
    expect(() => service.setWanted(false)).not.toThrow()
  })
})
