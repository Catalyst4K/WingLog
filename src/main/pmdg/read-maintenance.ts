import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { MaintenanceReport } from '@shared/ipc'
import { resolvePackageDir } from '../wasm-maintenance/package-dir'
import { buildMaintenanceReport } from './maintenance'

/** Reads and parses `<pmdg-aircraft-77w package dir>/work/Aircraft/<registration>.hours`
 *  (docs/wasm-maintenance-notes.md, flightdeck-backend — confirmed against Callum's real
 *  install: PMDG names this file directly by registration, no livery mapping needed).
 *
 *  Returns null for every reason there's nothing to show: no folder configured, the package
 *  folder isn't found under it (see resolvePackageDir), the file doesn't exist (this
 *  aircraft isn't a PMDG 777, or it is but hasn't flown with this folder configured yet), or
 *  any other read error — detection is deliberately just "did the read succeed" rather than
 *  a hardcoded icaoType allow-list that would go stale (docs/plans/fleet-maintenance.md
 *  Part 1). Never throws.
 *
 *  Path safety: `folderPath` is always a prior native folder-picker result (or empty),
 *  same trust level GSX already relies on for its own folder setting. `registration`,
 *  however, comes from the `aircraft` table and has no format constraint — resolving the
 *  built path and confirming it's still inside the expected Aircraft directory closes the
 *  path-escape case CLAUDE.md's security section calls out. */
export async function readPmdg777Maintenance(
  folderPath: string | null,
  registration: string
): Promise<MaintenanceReport | null> {
  if (!folderPath) return null

  const packageDir = await resolvePackageDir(folderPath, 'pmdg-aircraft-77w')
  if (!packageDir) return null

  const aircraftDir = resolve(join(packageDir, 'work', 'Aircraft'))
  const filePath = resolve(join(aircraftDir, `${registration}.hours`))
  if (dirname(filePath) !== aircraftDir) return null

  try {
    const text = await readFile(filePath, 'utf-8')
    return buildMaintenanceReport(text)
  } catch {
    return null
  }
}
