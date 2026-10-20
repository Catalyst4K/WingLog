import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TrayController, type CloseEventLike, type TrayActions, type WindowLike } from './TrayController'

/** A window that records what was done to it, and lets a test fire its events. */
function fakeWindow() {
  let visible = true
  let minimized = false
  let destroyed = false
  let onClose: (event: CloseEventLike) => void = () => undefined
  let onSessionEnd: () => void = () => undefined
  const window: WindowLike = {
    hide: vi.fn(() => {
      visible = false
    }),
    show: vi.fn(() => {
      visible = true
    }),
    focus: vi.fn(),
    restore: vi.fn(() => {
      minimized = false
    }),
    isMinimized: () => minimized,
    isVisible: () => visible,
    isDestroyed: () => destroyed,
    on: ((event: string, listener: never) => {
      if (event === 'close') onClose = listener
      else onSessionEnd = listener
    }) as WindowLike['on']
  }
  return {
    window,
    minimize: () => {
      minimized = true
      visible = false
    },
    destroy: () => {
      destroyed = true
    },
    /** Closes the window, returning whether the close was cancelled. */
    close: (): boolean => {
      const preventDefault = vi.fn()
      onClose({ preventDefault })
      return preventDefault.mock.calls.length > 0
    },
    endSession: () => onSessionEnd()
  }
}

describe('TrayController', () => {
  let setting: boolean
  let flightActive: boolean
  let actions: TrayActions
  const setToolTip = vi.fn()
  const destroyTray = vi.fn()
  const createTray = vi.fn((a: TrayActions) => {
    actions = a
    return { setToolTip, destroy: destroyTray }
  })
  const quit = vi.fn()

  function build(win: ReturnType<typeof fakeWindow>, isTrayAvailable = true): TrayController {
    const controller = new TrayController({
      window: win.window,
      isTrayAvailable,
      isCloseToTray: () => setting,
      isFlightActive: () => flightActive,
      createTray,
      quit,
      translate: (key) => key
    })
    controller.start()
    return controller
  }

  beforeEach(() => {
    setting = false
    flightActive = false
    vi.clearAllMocks()
  })

  it('lets the window close (and the app quit) while the setting is off, and shows no tray', () => {
    const win = fakeWindow()
    build(win)
    expect(createTray).not.toHaveBeenCalled()
    expect(win.close()).toBe(false)
    expect(win.window.hide).not.toHaveBeenCalled()
  })

  it('hides the window instead of closing it while the setting is on, and shows the tray icon from the start', () => {
    setting = true
    const win = fakeWindow()
    build(win)
    expect(createTray).toHaveBeenCalledTimes(1)
    expect(win.close()).toBe(true)
    expect(win.window.hide).toHaveBeenCalledTimes(1)
  })

  it('never builds a tray where none is available, whatever the setting says', () => {
    setting = true
    const win = fakeWindow()
    build(win, false)
    expect(createTray).not.toHaveBeenCalled()
    expect(win.close()).toBe(false)
  })

  it('does not hold back a real quit, or Windows shutting down', () => {
    setting = true
    const quitting = fakeWindow()
    build(quitting).markQuitting()
    expect(quitting.close()).toBe(false)

    const shutdown = fakeWindow()
    build(shutdown)
    shutdown.endSession()
    expect(shutdown.close()).toBe(false)
  })

  it('brings the window back from a tray click, restoring it first if it was minimised', () => {
    setting = true
    const win = fakeWindow()
    build(win)
    win.minimize()
    actions.onOpen()
    expect(win.window.restore).toHaveBeenCalledTimes(1)
    expect(win.window.show).toHaveBeenCalledTimes(1)
    expect(win.window.focus).toHaveBeenCalledTimes(1)
  })

  it('does not touch a window that is already gone', () => {
    setting = true
    const win = fakeWindow()
    build(win)
    win.destroy()
    actions.onOpen()
    expect(win.window.show).not.toHaveBeenCalled()
  })

  it('reports whether a tray is possible here', () => {
    expect(build(fakeWindow()).isAvailable).toBe(true)
    expect(build(fakeWindow(), false).isAvailable).toBe(false)
  })

  it('quits from the tray menu', () => {
    setting = true
    build(fakeWindow())
    actions.onQuit()
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('adds and removes the tray as the setting changes, showing a hidden window when it is removed', () => {
    const win = fakeWindow()
    const controller = build(win)
    setting = true
    controller.sync()
    controller.sync()
    expect(createTray).toHaveBeenCalledTimes(1)
    win.close()
    expect(win.window.isVisible()).toBe(false)

    setting = false
    controller.sync()
    expect(destroyTray).toHaveBeenCalledTimes(1)
    expect(win.window.isVisible()).toBe(true)
    expect(win.close()).toBe(false)
  })

  it('leaves a visible window alone when the tray is removed', () => {
    setting = true
    const win = fakeWindow()
    const controller = build(win)
    setting = false
    controller.sync()
    expect(win.window.show).not.toHaveBeenCalled()
  })

  it('says in the tooltip whether a flight is being tracked', () => {
    setting = true
    const controller = build(fakeWindow())
    expect(setToolTip).toHaveBeenLastCalledWith('tray.tooltip')
    flightActive = true
    controller.updateToolTip()
    expect(setToolTip).toHaveBeenLastCalledWith('tray.tooltipTracking')
  })

  it('has nothing to retitle without a tray, and removes the tray at quit', () => {
    const controller = build(fakeWindow())
    expect(() => controller.updateToolTip()).not.toThrow()
    setting = true
    controller.sync()
    controller.dispose()
    expect(destroyTray).toHaveBeenCalledTimes(1)
    controller.dispose()
    expect(destroyTray).toHaveBeenCalledTimes(1)
  })
})
