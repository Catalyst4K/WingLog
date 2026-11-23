/** Where the running app's icon pictures live: the tray icon, the window's taskbar icon and the Dock icon. */

import { join } from 'node:path'

/** The light mark ("a"), as electron-builder copies it into the installed app's resources. */
export const APP_ICON_LIGHT_FILENAME = 'tray-icon.png'
/** The dark mark ("b"), copied the same way. */
export const APP_ICON_DARK_FILENAME = 'tray-icon-dark.png'

/**
 * Where the icon picture for the system's light or dark setting is: in the installed app's resources
 * (electron-builder's extraResources), or the pictures in the build folder when running from source
 * (winglog-backend's docs/plans/logo-v2.md).
 *
 * @param isPackaged Whether this is the installed app.
 * @param resourcesPath The installed app's resources folder.
 * @param appPath The app's root when running from source.
 * @param isDark Whether the system is in dark mode.
 * @returns The picture's path.
 */
export function appIconPath(
  isPackaged: boolean,
  resourcesPath: string,
  appPath: string,
  isDark: boolean
): string {
  if (isPackaged) return join(resourcesPath, isDark ? APP_ICON_DARK_FILENAME : APP_ICON_LIGHT_FILENAME)
  return join(appPath, 'build', isDark ? 'icon-dark.png' : 'icon.png')
}
