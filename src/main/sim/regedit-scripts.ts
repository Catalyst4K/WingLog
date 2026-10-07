/**
 * Points node-simconnect's registry helper at scripts it can actually run in the packaged app.
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'

interface Regedit {
  setExternalVBSLocation(path: string): string
}

/**
 * node-simconnect reads MSFS's SimConnect port from the registry (only while the sim's named
 * pipe doesn't exist yet — MSFS off or still loading) through `regedit`, which runs helper
 * .wsf/.vbs scripts with Windows Script Host. Packaged, those scripts sat inside app.asar,
 * which cscript can't read: every 30 s reconnect logged "Can not find script file
 * …regList.wsf" (6,600+ lines in one user's main.log by 2026-10-02). electron-builder.yml
 * unpacks them; this points regedit at the unpacked copy — regedit's own documented remedy.
 *
 * Resolved from node-simconnect's own location so it's the same regedit instance it uses
 * (regedit isn't a direct dependency, so a plain import would be bundled as a second copy).
 * Returns regedit's own result ('Folder found and set' / 'Folder not found'), or null when
 * not packaged.
 *
 * @param isPackaged Whether this is the installed app (Electron's app.isPackaged).
 * @param resourcesPath Electron's process.resourcesPath.
 * @param load Loads the regedit module; injected for tests.
 * @returns The script folder set, or null when nothing needed changing.
 */
export function pointRegeditAtUnpackedScripts(
  isPackaged: boolean,
  resourcesPath: string,
  load: (id: string) => unknown = (id) => createRequire(require.resolve('node-simconnect'))(id)
): string | null {
  if (!isPackaged) return null
  const regedit = load('regedit') as Regedit
  return regedit.setExternalVBSLocation(
    join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'regedit', 'vbs')
  )
}
