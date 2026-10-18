import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StorageStatus } from '@shared/ipc'
import { CHECK_INTERVAL_MS, CRITICAL_BYTES, DiskSpaceMonitor, LOW_BYTES, levelFor } from './disk-space'

const GIB = 1024 ** 3

describe('levelFor', () => {
  it('warns under 5 GB, and again under 1 GB, and not for an unreadable drive', () => {
    expect(levelFor(40 * GIB)).toBe('ok')
    expect(levelFor(LOW_BYTES)).toBe('ok')
    expect(levelFor(LOW_BYTES - 1)).toBe('low')
    expect(levelFor(CRITICAL_BYTES - 1)).toBe('critical')
    expect(levelFor(0)).toBe('critical')
    expect(levelFor(null)).toBe('ok')
  })
})

describe('DiskSpaceMonitor', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function monitor(free: { bytes: number }): { monitor: DiskSpaceMonitor; seen: StorageStatus[] } {
    const m = new DiskSpaceMonitor({
      folder: 'C:/data',
      readFreeBytes: () => Promise.resolve(free.bytes),
      log: () => {}
    })
    const seen: StorageStatus[] = []
    m.on('status', (s) => seen.push(s))
    return { monitor: m, seen }
  }

  it('says nothing while there is room, and warns once the free space drops, then again as it runs out', async () => {
    const free = { bytes: 50 * GIB }
    const { monitor: m, seen } = monitor(free)
    m.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(m.getStatus()).toEqual({ freeBytes: 50 * GIB, level: 'ok', saveFailing: false })
    expect(seen).toEqual([])

    free.bytes = 4.2 * GIB
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    expect(seen.at(-1)).toMatchObject({ level: 'low' })

    free.bytes = 0.4 * GIB
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    expect(seen.at(-1)).toMatchObject({ level: 'critical' })

    free.bytes = 80 * GIB
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    expect(seen.at(-1)).toMatchObject({ level: 'ok' })
    m.stop()
  })

  it('does not repeat a warning whose figure has not changed, but does when it has (tenths of a GB)', async () => {
    const free = { bytes: 3 * GIB }
    const { monitor: m, seen } = monitor(free)
    await m.check()
    expect(seen).toHaveLength(1)
    await m.check()
    expect(seen).toHaveLength(1)
    free.bytes = 2.5 * GIB
    await m.check()
    expect(seen).toHaveLength(2)
    expect(seen[1].freeBytes).toBe(2.5 * GIB)
  })

  it('reports saving that fails and recovers, and looks at the disk at once when it fails', async () => {
    const reads = vi.fn(() => Promise.resolve(3 * GIB))
    const m = new DiskSpaceMonitor({ folder: 'C:/data', readFreeBytes: reads, log: () => {} })
    const seen: StorageStatus[] = []
    m.on('status', (s) => seen.push(s))

    m.setSaveFailing(true)
    expect(seen[0]).toMatchObject({ saveFailing: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(reads).toHaveBeenCalledTimes(1)
    expect(m.getStatus()).toMatchObject({ saveFailing: true, level: 'low' })

    m.setSaveFailing(true) // no change, no event
    const count = seen.length
    m.setSaveFailing(false)
    expect(seen.length).toBe(count + 1)
    expect(m.getStatus().saveFailing).toBe(false)
  })

  it('treats a drive it cannot read as no warning, and logs it', async () => {
    const log = vi.fn()
    const m = new DiskSpaceMonitor({
      folder: 'C:/data',
      readFreeBytes: () => Promise.reject(new Error('EPERM')),
      log
    })
    await m.check()
    expect(m.getStatus()).toEqual({ freeBytes: null, level: 'ok', saveFailing: false })
    expect(log).toHaveBeenCalledWith('could not read the free space: Error: EPERM')
  })

  it('reads the real drive when none is given', async () => {
    vi.useRealTimers()
    const m = new DiskSpaceMonitor({ folder: process.cwd() })
    await m.check()
    expect(m.getStatus().freeBytes).toBeGreaterThan(0)
  })
})
