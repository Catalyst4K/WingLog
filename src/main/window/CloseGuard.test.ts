import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CloseGuard, type CloseEventLike } from './CloseGuard'

/** A window whose close and session-end a test can fire. */
function fakeWindow() {
  let onClose: (event: CloseEventLike) => void = () => undefined
  let onSessionEnd: () => void = () => undefined
  const close = vi.fn()
  return {
    close,
    window: {
      close,
      on: ((event: string, listener: never) => {
        if (event === 'close') onClose = listener
        else onSessionEnd = listener
      }) as never
    },
    /** Closes the window, returning whether the close was held back. */
    tryClose: (): boolean => {
      const preventDefault = vi.fn()
      onClose({ preventDefault })
      return preventDefault.mock.calls.length > 0
    },
    endSession: () => onSessionEnd()
  }
}

describe('CloseGuard', () => {
  let flightActive: boolean
  const onError = vi.fn()

  function build(answer: () => Promise<boolean>) {
    const win = fakeWindow()
    const confirmClose = vi.fn(answer)
    new CloseGuard({
      window: win.window,
      isFlightInProgress: () => flightActive,
      confirmClose,
      onError
    }).start()
    return { ...win, confirmClose }
  }

  beforeEach(() => {
    flightActive = false
    vi.clearAllMocks()
  })

  it('lets the window close without asking when no flight is being tracked', () => {
    const guard = build(() => Promise.resolve(true))
    expect(guard.tryClose()).toBe(false)
    expect(guard.confirmClose).not.toHaveBeenCalled()
  })

  it('holds the close and asks while a flight is tracked, and leaves WingLog open if the pilot says no', async () => {
    flightActive = true
    const guard = build(() => Promise.resolve(false))
    expect(guard.tryClose()).toBe(true)
    await vi.waitFor(() => expect(guard.confirmClose).toHaveBeenCalledTimes(1))
    expect(guard.close).not.toHaveBeenCalled()
    // Asked again next time, not remembered as a no.
    await vi.waitFor(() => {
      guard.tryClose()
      expect(guard.confirmClose).toHaveBeenCalledTimes(2)
    })
  })

  it('closes the window once the pilot confirms, and does not ask again for that close', async () => {
    flightActive = true
    const guard = build(() => Promise.resolve(true))
    expect(guard.tryClose()).toBe(true)
    await vi.waitFor(() => expect(guard.close).toHaveBeenCalledTimes(1))
    expect(guard.tryClose()).toBe(false)
    expect(guard.confirmClose).toHaveBeenCalledTimes(1)
  })

  it('asks only once while the question is still open', async () => {
    flightActive = true
    let answer: (close: boolean) => void = () => undefined
    const guard = build(() => new Promise<boolean>((resolve) => (answer = resolve)))
    guard.tryClose()
    guard.tryClose()
    expect(guard.confirmClose).toHaveBeenCalledTimes(1)
    answer(false)
    await vi.waitFor(() => {
      guard.tryClose()
      expect(guard.confirmClose).toHaveBeenCalledTimes(2)
    })
  })

  it('logs a failure to ask, and does not close', async () => {
    flightActive = true
    const failure = new Error('no dialog')
    const guard = build(() => Promise.reject(failure))
    guard.tryClose()
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure))
    expect(guard.close).not.toHaveBeenCalled()
  })

  it('never holds up Windows shutting down', () => {
    flightActive = true
    const guard = build(() => Promise.resolve(false))
    guard.endSession()
    expect(guard.tryClose()).toBe(false)
    expect(guard.confirmClose).not.toHaveBeenCalled()
  })
})
