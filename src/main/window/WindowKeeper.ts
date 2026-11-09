/**
 * Keeps the main window alive when it is closed on macOS, where closing the last window does not quit the app and clicking the Dock icon
 * opens a window again. Every service is given the window it was started with and sends its live updates to it; a replacement window
 * would hear nothing, and a page on it would only show new values after being left and opened again (winglog-backend's
 * docs/plans/multi-device.md, findings F2, F5 and F6). So closing hides this window instead of destroying it, and the Dock shows it again.
 */

import { keepsWindowWhenClosed, type Platform } from '../platform/platform'

/** The close event, which can be cancelled. */
export interface KeeperCloseEvent {
  preventDefault(): void
}

/** What the keeper needs from the main window. */
export interface KeptWindow {
  hide(): void
  show(): void
  focus(): void
  isMinimized(): boolean
  restore(): void
  on(event: 'close', listener: (event: KeeperCloseEvent) => void): void
}

/** Hides the window instead of closing it, until the app is quitting. */
export class WindowKeeper {
  private isQuitting = false

  /** @param window The main window. */
  constructor(private readonly window: KeptWindow) {}

  /** Starts listening to the window. */
  start(): void {
    this.window.on('close', (event) => {
      if (this.isQuitting) return
      event.preventDefault()
      this.window.hide()
    })
  }

  /** The app is quitting (Cmd+Q, the Dock menu, an update): from now on the window may close. */
  markQuitting(): void {
    this.isQuitting = true
  }

  /** Shows the window again, as the Dock icon asks. */
  reopen(): void {
    if (this.window.isMinimized()) this.window.restore()
    this.window.show()
    this.window.focus()
  }
}

/** The parts of Electron's `app` the keeper listens to. */
export interface KeeperApp {
  on(event: 'before-quit' | 'activate', listener: () => void): void
}

/**
 * Where it applies (macOS), hides the main window when it is closed and shows it again from the Dock, until the app quits.
 *
 * @param app Electron's app.
 * @param window The main window.
 * @param platform The platform to ask about; defaults to this machine's.
 */
export function keepWindowWhenClosed(app: KeeperApp, window: KeptWindow, platform?: Platform): void {
  if (!keepsWindowWhenClosed(platform)) return
  const keeper = new WindowKeeper(window)
  keeper.start()
  app.on('before-quit', () => keeper.markQuitting())
  app.on('activate', () => keeper.reopen())
}
