/** Where the tray icon's picture lives. */

import { join } from 'node:path'

export const TRAY_ICON_FILENAME = 'tray-icon.png'

/**
 * Where the tray icon is: in the installed app's resources (electron-builder's extraResources), or the
 * app icon in the build folder when running from source.
 *
 * @param isPackaged Whether this is the installed app.
 * @param resourcesPath The installed app's resources folder.
 * @param appPath The app's root when running from source.
 * @returns The picture's path.
 */
export function trayIconPath(isPackaged: boolean, resourcesPath: string, appPath: string): string {
  return isPackaged ? join(resourcesPath, TRAY_ICON_FILENAME) : join(appPath, 'build', 'icon.png')
}
