import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IpcChannels } from '@shared/ipc'
import { dataChangedNotifier, DATA_CHANGED_DELAY_MS } from './data-changed'

describe('dataChangedNotifier', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function window(destroyed = false) {
    return { isDestroyed: () => destroyed, webContents: { send: vi.fn() } }
  }

  it('tells the window once, a moment later, however many changes there were', () => {
    const w = window()
    const notify = dataChangedNotifier(w)
    notify()
    notify()
    notify()
    expect(w.webContents.send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(DATA_CHANGED_DELAY_MS)
    expect(w.webContents.send).toHaveBeenCalledTimes(1)
    expect(w.webContents.send).toHaveBeenCalledWith(IpcChannels.dataChanged)
  })

  it('tells it again for a later change', () => {
    const w = window()
    const notify = dataChangedNotifier(w)
    notify()
    vi.advanceTimersByTime(DATA_CHANGED_DELAY_MS)
    notify()
    vi.advanceTimersByTime(DATA_CHANGED_DELAY_MS)
    expect(w.webContents.send).toHaveBeenCalledTimes(2)
  })

  it('says nothing to a window that is gone', () => {
    const w = window(true)
    dataChangedNotifier(w)()
    vi.advanceTimersByTime(DATA_CHANGED_DELAY_MS)
    expect(w.webContents.send).not.toHaveBeenCalled()
  })
})
