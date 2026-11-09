import { describe, expect, it, vi } from 'vitest'
import {
  keepWindowWhenClosed,
  WindowKeeper,
  type KeeperApp,
  type KeeperCloseEvent,
  type KeptWindow
} from './WindowKeeper'

/** A window that records what was done to it and lets a test fire its close event. */
function fakeWindow(minimized = false): KeptWindow & { close(): { prevented: boolean } } {
  let onClose: ((event: KeeperCloseEvent) => void) | null = null
  return {
    hide: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    isMinimized: () => minimized,
    restore: vi.fn(),
    on: (_event, listener) => {
      onClose = listener
    },
    close() {
      let prevented = false
      onClose?.({ preventDefault: () => (prevented = true) })
      return { prevented }
    }
  }
}

describe('WindowKeeper', () => {
  it('hides the window instead of closing it, so the services keep the window they send to', () => {
    const window = fakeWindow()
    new WindowKeeper(window).start()
    expect(window.close().prevented).toBe(true)
    expect(window.hide).toHaveBeenCalledTimes(1)
  })

  it('lets the window close once the app is quitting', () => {
    const window = fakeWindow()
    const keeper = new WindowKeeper(window)
    keeper.start()
    keeper.markQuitting()
    expect(window.close().prevented).toBe(false)
    expect(window.hide).not.toHaveBeenCalled()
  })

  it('shows and focuses the same window again for the Dock icon, restoring it first when minimised', () => {
    const window = fakeWindow(true)
    new WindowKeeper(window).reopen()
    expect(window.restore).toHaveBeenCalledTimes(1)
    expect(window.show).toHaveBeenCalledTimes(1)
    expect(window.focus).toHaveBeenCalledTimes(1)
  })

  it('does not restore a window that is not minimised', () => {
    const window = fakeWindow(false)
    new WindowKeeper(window).reopen()
    expect(window.restore).not.toHaveBeenCalled()
    expect(window.show).toHaveBeenCalledTimes(1)
  })
})

/** An app that lets a test fire the events the keeper listens to. */
function fakeApp(): KeeperApp & { emit(event: 'before-quit' | 'activate'): void } {
  const listeners = new Map<string, () => void>()
  return {
    on: (event, listener) => void listeners.set(event, listener),
    emit: (event) => listeners.get(event)?.()
  }
}

describe('keepWindowWhenClosed', () => {
  it('on macOS hides on close, shows the same window for the Dock, and lets it close when quitting', () => {
    const app = fakeApp()
    const window = fakeWindow()
    keepWindowWhenClosed(app, window, 'darwin')
    expect(window.close().prevented).toBe(true)
    app.emit('activate')
    expect(window.show).toHaveBeenCalledTimes(1)
    app.emit('before-quit')
    expect(window.close().prevented).toBe(false)
  })

  it('does nothing on Windows or Linux, where closing the window quits', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const app = fakeApp()
      const window = fakeWindow()
      keepWindowWhenClosed(app, window, platform)
      expect(window.close().prevented).toBe(false)
      app.emit('activate')
      expect(window.show).not.toHaveBeenCalled()
    }
  })
})
