/**
 * Keeps WingLog running in a tray icon when the window is closed (winglog-backend's docs/plans/tray.md).
 *
 * With the "keep running in the tray" setting on, closing the main window hides it instead of quitting,
 * and a tray icon brings it back. Tracking, the second screen and the add-on links live in the main process,
 * so they carry on while the window is hidden. A real quit (the tray's Quit, an update restart, Windows
 * shutdown) is never held back. The Electron pieces (the window, the tray) come in through small interfaces,
 * so the decisions here are tested without Electron.
 */

/** The close event, which can be cancelled. */
export interface CloseEventLike {
  preventDefault(): void
}

/** What the controller needs from the main window. */
export interface WindowLike {
  hide(): void
  show(): void
  focus(): void
  restore(): void
  isMinimized(): boolean
  isVisible(): boolean
  isDestroyed(): boolean
  on(event: 'close', listener: (event: CloseEventLike) => void): void
  on(event: 'session-end', listener: () => void): void
}

/** A tray icon that has been created. */
export interface TrayHandle {
  setToolTip(text: string): void
  destroy(): void
}

/** What the tray icon's clicks and menu do. */
export interface TrayActions {
  onOpen: () => void
  onQuit: () => void
}

/** What the controller is built from. */
export interface TrayControllerDeps {
  window: WindowLike
  /** Whether this platform can show a tray icon at all. */
  isTrayAvailable: boolean
  /** The pilot's setting, read each time it matters. */
  isCloseToTray: () => boolean
  /** Whether a flight is being tracked, for the tooltip. */
  isFlightActive: () => boolean
  /** Makes the real tray icon. */
  createTray: (actions: TrayActions) => TrayHandle
  /** Quits the app. */
  quit: () => void
  /** Translates a main-process string. */
  translate: (key: string) => string
}

/** Hides the window to the tray on close, and brings it back. */
export class TrayController {
  private tray: TrayHandle | null = null
  private isQuitting = false

  constructor(private readonly deps: TrayControllerDeps) {}

  /** Whether this platform can show a tray icon at all. */
  get isAvailable(): boolean {
    return this.deps.isTrayAvailable
  }

  /** Starts listening to the window, and shows the tray icon if the setting is already on. */
  start(): void {
    this.deps.window.on('close', (event) => this.handleClose(event))
    // Windows is shutting down or logging off: a window that refuses to close would hold it up.
    this.deps.window.on('session-end', () => this.markQuitting())
    this.sync()
  }

  /** Called when the app is about to quit for real, so closing the window is let through. */
  markQuitting(): void {
    this.isQuitting = true
  }

  /**
   * Brings the tray icon in line with the setting: shown while it is on, gone while it is off. Turning it off
   * while the window is hidden shows the window first, so the pilot is not left with no way in.
   */
  sync(): void {
    const wanted = this.deps.isTrayAvailable && this.deps.isCloseToTray()
    if (wanted && !this.tray) {
      this.tray = this.deps.createTray({ onOpen: () => this.showWindow(), onQuit: () => this.deps.quit() })
      this.updateToolTip()
    } else if (!wanted && this.tray) {
      this.tray.destroy()
      this.tray = null
      if (!this.deps.window.isDestroyed() && !this.deps.window.isVisible()) this.showWindow()
    }
  }

  /** Sets the tray tooltip to say whether a flight is being tracked. Call it when tracking starts or stops. */
  updateToolTip(): void {
    const key = this.deps.isFlightActive() ? 'tray.tooltipTracking' : 'tray.tooltip'
    this.tray?.setToolTip(this.deps.translate(key))
  }

  /** Shows the window, restoring it if minimised, and gives it focus. */
  showWindow(): void {
    const { window } = this.deps
    if (window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  /** Removes the tray icon, at quit. */
  dispose(): void {
    this.tray?.destroy()
    this.tray = null
  }

  private handleClose(event: CloseEventLike): void {
    if (this.isQuitting || !this.tray) return
    event.preventDefault()
    this.deps.window.hide()
  }
}
