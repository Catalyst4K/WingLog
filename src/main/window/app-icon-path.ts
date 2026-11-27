/** Where the running app's icon pictures live: the tray icon, the window's taskbar icon and the Dock icon. */

import { join } from 'node:path'
import type { Platform } from '../platform/platform'

/**
 * Where the icon picture for the system's light or dark setting is: in the installed app's resources
 * (electron-builder's extraResources), or in the build folder when running from source (winglog-backend's
 * docs/plans/logo-v2.md). Windows gets the .ico, which holds every size drawn by hand, so a 16 or 32 px
 * tray or taskbar icon is not a shrunk 1024 px picture; the other platforms get the PNG.
 *
 * @param isPackaged Whether this is the installed app.
 * @param resourcesPath The installed app's resources folder.
 * @param appPath The app's root when running from source.
 * @param isDark Whether the system is in dark mode.
 * @param platform The platform the app runs on.
 * @returns The picture's path.
 */
export function appIconPath(
  isPackaged: boolean,
  resourcesPath: string,
  appPath: string,
  isDark: boolean,
  platform: Platform
): string {
  const suffix = isDark ? '-dark' : ''
  const extension = platform === 'win32' ? 'ico' : 'png'
  if (isPackaged) {
    const name = platform === 'win32' ? `app-icon${suffix}.ico` : `tray-icon${suffix}.png`
    return join(resourcesPath, name)
  }
  return join(appPath, 'build', `icon${suffix}.${extension}`)
}
