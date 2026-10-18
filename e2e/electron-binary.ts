import { join } from 'node:path'

/** The real Electron executable inside node_modules, not the .bin shim (a .cmd on Windows,
 *  which execFileSync can't run without a shell). macOS keeps it inside the app bundle. */
export function electronBinary(): string {
  const dist = join('node_modules', 'electron', 'dist')
  if (process.platform === 'win32') return join(dist, 'electron.exe')
  if (process.platform === 'darwin') return join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron')
  return join(dist, 'electron')
}
