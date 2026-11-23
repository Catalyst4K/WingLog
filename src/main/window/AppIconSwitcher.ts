/**
 * Keeps the tray icon, the window's taskbar icon and the Dock icon matching the system's light or dark setting
 * (winglog-backend's docs/plans/logo-v2.md): the light mark "a" in light mode, the dark mark "b" in dark mode.
 * The Electron pieces come in through functions, so the choice is tested without Electron.
 */

import type { Platform } from '../platform/platform'

/** What the switcher is built from. */
export interface AppIconSwitcherDeps {
  /** This machine's platform: macOS has a Dock icon, the others a taskbar icon on the window. */
  platform: Platform
  /** The picture's path for the system's setting right now. */
  currentIconPath: () => string
  /** Puts a picture on the tray icon, if there is one. */
  setTrayIcon: (path: string) => void
  /** Puts a picture on the window's taskbar icon (Windows and Linux). */
  setWindowIcon: (path: string) => void
  /** Puts a picture on the Dock icon (macOS). */
  setDockIcon: (path: string) => void
}

/** Applies the icon for the system's setting. Call `apply` at start-up and whenever the system's setting changes. */
export class AppIconSwitcher {
  constructor(private readonly deps: AppIconSwitcherDeps) {}

  /** Puts the picture for the system's current setting on every icon this platform can change while running. */
  apply(): void {
    const path = this.deps.currentIconPath()
    this.deps.setTrayIcon(path)
    if (this.deps.platform === 'darwin') this.deps.setDockIcon(path)
    else this.deps.setWindowIcon(path)
  }
}
