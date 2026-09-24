import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { MaintenanceReport } from '@shared/ipc'
import { buildMaintenanceReport } from './maintenance'

/** Where a matched `.data` file was found for one aircraft's most recent Fleet check —
 *  `path` is only ever built from directory names `readdir` itself returned, never from
 *  `registration` interpolated into a path, so there's no path-escape case to guard against
 *  here the way PMDG's registration-in-filename lookup needs (CLAUDE.md's security section). */
interface MatchedFile {
  path: string
  mtimeMs: number
}

/** iniBuilds keys its `.data` files by livery, not always by registration
 *  (docs/wasm-maintenance-notes.md, flightdeck-backend) — a normal livery's filename does
 *  carry its registration (`CATHAY PACIFIC B-LRJ.data`), but iniBuilds' space-saving
 *  "commons" packs and the unbranded default don't. Rather than trying to parse a
 *  registration out of an arbitrary filename, this looks for the registration WingLog
 *  already knows as a substring of the filename — the same relationship confirmed in every
 *  real sample. A file with no registration in its name (a commons pack, the unbranded
 *  default) simply never matches, same as any other unsupported case. */
async function findMatchingFiles(maintenanceDir: string, registration: string): Promise<MatchedFile[]> {
  const needle = registration.toLowerCase()
  const matches: MatchedFile[] = []

  let variantDirs: string[]
  try {
    variantDirs = await readdir(maintenanceDir)
  } catch {
    return []
  }

  for (const variantDir of variantDirs) {
    const variantPath = join(maintenanceDir, variantDir)
    let entries: string[]
    try {
      entries = await readdir(variantPath)
    } catch {
      continue // not a directory, or unreadable — skip, not an error
    }
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith('.data')) continue
      if (!entry.toLowerCase().includes(needle)) continue
      const path = join(variantPath, entry)
      try {
        const stats = await stat(path)
        matches.push({ path, mtimeMs: stats.mtimeMs })
      } catch {
        continue
      }
    }
  }

  return matches
}

/** Reads and parses whichever `.data` file under
 *  `<folderPath>/inibuilds-aircraft-a350/work/Maintenance/<variant>/` has the given
 *  registration in its filename. When more than one livery's file matches (a tail with
 *  several installed liveries), the most recently modified one wins — the one the sim most
 *  recently wrote, matching whichever livery was actually flown last.
 *
 *  Returns null for every reason there's nothing to show: no folder configured, no
 *  `Maintenance` directory, or no file with this registration in its name (this aircraft
 *  isn't an A350, or it is but every installed livery for it happens to be an unbranded
 *  default/"commons" pack with no registration in its filename) — never throws. */
export async function readIniBuildsA350Maintenance(
  folderPath: string | null,
  registration: string
): Promise<MaintenanceReport | null> {
  if (!folderPath) return null

  const maintenanceDir = join(folderPath, 'inibuilds-aircraft-a350', 'work', 'Maintenance')
  const matches = await findMatchingFiles(maintenanceDir, registration)
  if (matches.length === 0) return null

  const newest = matches.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a))
  try {
    const text = await readFile(newest.path, 'utf-8')
    return buildMaintenanceReport(text)
  } catch {
    return null
  }
}
