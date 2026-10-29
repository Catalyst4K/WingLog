/**
 * Where WingLog's files are on each operating system. Every function takes the platform and the environment it needs, so each OS's answer
 * can be tested on any machine, and builds the path with that OS's own `path` functions rather than the ambient ones.
 */

import { posix, win32 } from 'node:path'
import type { Platform } from './platform'

/** The name of WingLog's folder under the OS's per-user application data folder (Electron's `userData`). */
const APP_FOLDER = 'WingLog'

/**
 * WingLog's data folder (where `winglog.db`, `logs` and `captures` live), matching Electron's `app.getPath('userData')`: `%APPDATA%\WingLog`
 * on Windows, `~/Library/Application Support/WingLog` on macOS, `$XDG_CONFIG_HOME/WingLog` (else `~/.config/WingLog`) on Linux. For the dev
 * scripts and tests, which run outside Electron.
 *
 * @param platform The platform.
 * @param env The environment variables (`APPDATA`, `XDG_CONFIG_HOME`).
 * @param home The user's home folder.
 * @returns The folder, or null when Windows has no `APPDATA` set.
 */
export function userDataDirectory(
  platform: Platform,
  env: Record<string, string | undefined>,
  home: string
): string | null {
  if (platform === 'win32') return env.APPDATA ? win32.join(env.APPDATA, APP_FOLDER) : null
  if (platform === 'darwin') return posix.join(home, 'Library', 'Application Support', APP_FOLDER)
  return posix.join(env.XDG_CONFIG_HOME || posix.join(home, '.config'), APP_FOLDER)
}

/**
 * Where MSFS 2024 keeps its `UserCfg.opt`, which names its packages folder: the Microsoft Store build's `%LOCALAPPDATA%\Packages\...`, then
 * Steam's `%APPDATA%\Microsoft Flight Simulator 2024`. MSFS runs on Windows only, and WingLog talks to MSFS 2024 only, so MSFS 2020's
 * folders are not here.
 *
 * @param platform The platform.
 * @param env The environment variables (`LOCALAPPDATA`, `APPDATA`).
 * @returns The candidate paths, in order; none off Windows.
 */
export function msfsUserCfgPaths(platform: Platform, env: Record<string, string | undefined>): string[] {
  if (platform !== 'win32') return []
  const paths: string[] = []
  if (env.LOCALAPPDATA)
    paths.push(
      win32.join(
        env.LOCALAPPDATA,
        'Packages',
        'Microsoft.Limitless_8wekyb3d8bbwe',
        'LocalCache',
        'UserCfg.opt'
      )
    )
  if (env.APPDATA) paths.push(win32.join(env.APPDATA, 'Microsoft Flight Simulator 2024', 'UserCfg.opt'))
  return paths
}

/**
 * Where GSX writes its receipts, to pre-fill Settings. GSX is a Windows-only product, so this only ever resolves on Windows. `%APPDATA%`
 * is the real variable Windows sets rather than an assumed `~/AppData/Roaming`: a user with a redirected profile folder would otherwise get
 * a wrong, confidently stated path. Only a pre-fill; the field stays editable, since a silently wrong detected path is worse than an
 * empty box. Built with `path.win32` whatever OS runs the code, so a test on Linux gets the Windows path.
 *
 * @param platform The platform.
 * @param env The environment variables (`APPDATA`).
 * @returns The folder, or null off Windows or without `APPDATA`.
 */
export function gsxReceiptsDefaultPath(
  platform: Platform,
  env: Record<string, string | undefined>
): string | null {
  if (platform !== 'win32' || !env.APPDATA) return null
  return win32.join(env.APPDATA, 'Virtuali', 'GSX', 'Receipts')
}
