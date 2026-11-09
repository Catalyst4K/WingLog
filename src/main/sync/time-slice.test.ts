import { describe, expect, it, vi } from 'vitest'
import { SLICE_MS, timeSlicer } from './time-slice'

describe('timeSlicer', () => {
  it('lets the work carry on without a pause until a slice has passed, then pauses once and starts a new slice', async () => {
    let clock = 0
    const pause = vi.fn(() => Promise.resolve())
    const slice = timeSlicer(8, () => clock, pause)
    clock = 3
    await slice()
    clock = 7
    await slice()
    expect(pause).not.toHaveBeenCalled()
    clock = 8
    await slice()
    expect(pause).toHaveBeenCalledTimes(1)
    // A new slice starts after the pause.
    clock = 12
    await slice()
    expect(pause).toHaveBeenCalledTimes(1)
    clock = 16
    await slice()
    expect(pause).toHaveBeenCalledTimes(2)
  })

  it('really hands the thread back: a timer waiting meanwhile runs before a long loop of slow rows ends', async () => {
    const slice = timeSlicer(1)
    let ticks = 0
    const timer = setInterval(() => (ticks += 1), 0)
    const end = performance.now() + 60
    // Rows that each take about 2 ms of the thread.
    while (performance.now() < end) {
      const rowEnd = performance.now() + 2
      while (performance.now() < rowEnd) {
        /* work */
      }
      await slice()
    }
    clearInterval(timer)
    expect(ticks).toBeGreaterThan(3)
  })

  it('works in slices of a few milliseconds by default', () => {
    expect(SLICE_MS).toBeLessThanOrEqual(16)
  })
})
