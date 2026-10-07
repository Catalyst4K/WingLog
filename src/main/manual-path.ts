/** Where the bundled user manual lives. */

import { join } from 'node:path'

export const MANUAL_FILENAME = 'WingLog Manual.pdf'

/**
 * Where the bundled manual is: in the installed app's resources (electron-builder's
 * extraResources), or where `npm run manual:build` writes it when running from source.
 *
 * @param isPackaged Whether this is the installed app.
 * @param resourcesPath The installed app's resources folder.
 * @param appPath The app's root when running from source.
 * @returns The manual's path.
 */
export function manualPath(isPackaged: boolean, resourcesPath: string, appPath: string): string {
  return isPackaged
    ? join(resourcesPath, MANUAL_FILENAME)
    : join(appPath, 'release', 'manual', MANUAL_FILENAME)
}
