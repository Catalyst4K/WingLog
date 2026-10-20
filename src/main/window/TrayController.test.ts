import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TrayController, type TrayActions, type WindowLike } from './TrayController'

/** A window that records what was done to it, and lets a test fire its events. */
function fakeWindow() {
  let visible = true
  let minimized = false
  let destroyed = false
  let onMinimize: () => void = () => undefined
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
    on: (_event, listener) => {
      onMinimize = listener
    }
  }
  return {
    window,
    /** Minimises the window, as the minimise button does. */
    minimize: () => {
      minimized = true
      onMinimize()
    },
    destroy: () => {
      destroyed = true
    }
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
      isMinimizeToTray: () => setting,
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

  it('leaves minimising to the taskbar while the setting is off, and shows no tray', () => {
    const win = fakeWindow()
    build(win)
    win.minimize()
    expect(createTray).not.toHaveBeenCalled()
    expect(win.window.hide).not.toHaveBeenCalled()
  })

  it('hides the window when it is minimised while the setting is on, with the tray icon there from the start', () => {
    setting = true
    const win = fakeWindow()
    build(win)
    expect(createTray).toHaveBeenCalledTimes(1)
    win.minimize()
    expect(win.window.hide).toHaveBeenCalledTimes(1)
  })

  it('never builds a tray where none is available, whatever the setting says', () => {
    setting = true
    const win = fakeWindow()
    build(win, false)
    win.minimize()
    expect(createTray).not.toHaveBeenCalled()
    expect(win.window.hide).not.toHaveBeenCalled()
  })

  it('brings the window back from a tray click, restoring it from minimised first', () => {
    setting = true
    const win = fakeWindow()
    build(win)
    win.minimize()
    actions.onOpen()
    expect(win.window.restore).toHaveBeenCalledTimes(1)
    expect(win.window.show).toHaveBeenCalledTimes(1)
    expect(win.window.focus).toHaveBeenCalledTimes(1)
    expect(win.window.isVisible()).toBe(true)
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
    win.minimize()
    expect(win.window.isVisible()).toBe(false)

    setting = false
    controller.sync()
    expect(destroyTray).toHaveBeenCalledTimes(1)
    expect(win.window.isVisible()).toBe(true)
    win.minimize()
    expect(win.window.hide).toHaveBeenCalledTimes(1)
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
