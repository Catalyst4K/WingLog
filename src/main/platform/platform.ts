/**
 * The operating system WingLog is running on, and what that means for what it can do. The one place that asks (docs/plans/cross-platform.md,
 * winglog-backend): everything else takes a platform, or one of the answers below, so it can be tested for each OS and the rest of the
 * code stays free of `process.platform`.
 */

export type Platform = 'win32' | 'darwin' | 'linux'

/**
 * @param value Node's `process.platform`, or a platform to ask about; defaults to this machine's.
 * @returns win32, darwin or linux. Any other Unix (the BSDs) is treated as Linux.
 */
export function currentPlatform(value: string = process.platform): Platform {
  return value === 'win32' || value === 'darwin' ? value : 'linux'
}

/**
 * Whether this install can be the host that talks to the sim: MSFS, SimConnect, GSX and BeyondATC all run on the Windows machine the sim
 * runs on. Anywhere else the app is a client of that machine's WingLog.
 *
 * @param platform The platform to ask about; defaults to this machine's.
 * @returns True on Windows.
 */
export function canHostSim(platform: Platform = currentPlatform()): boolean {
  return platform === 'win32'
}

/**
 * Whether WingLog can keep running in a tray icon. Windows only for now (winglog-backend's docs/plans/tray.md).
 *
 * @param platform The platform to ask about; defaults to this machine's.
 * @returns True on Windows.
 */
export function canShowTray(platform: Platform = currentPlatform()): boolean {
  return platform === 'win32'
}

/**
 * Whether closing the last window quits the app. macOS keeps an app running with no window, ready to reopen; Windows and Linux quit.
 *
 * @param platform The platform to ask about; defaults to this machine's.
 * @returns True off macOS.
 */
export function quitsWhenAllWindowsClose(platform: Platform = currentPlatform()): boolean {
  return platform !== 'darwin'
}
