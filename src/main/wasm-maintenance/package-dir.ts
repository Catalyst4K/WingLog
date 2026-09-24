import { stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Resolves a third-party add-on's real package folder under the user-chosen WASM storage
 *  folder, trying it directly first, then under an `MSFS2024` sibling.
 *
 *  Confirmed on a real install (docs/wasm-maintenance-notes.md, flightdeck-backend): the
 *  WASM folder itself can hold `MSFS2020`/`MSFS2024` siblings, each with their own copy of
 *  every add-on's package folder underneath — Callum's own WASM folder is exactly this
 *  shape. The Settings hint asks for "the folder containing pmdg-aircraft-77w and/or
 *  inibuilds-aircraft-a350", but the folder named "WASM" in Explorer is the natural thing to
 *  pick and doesn't itself satisfy that description on an install with the MSFS2020/2024
 *  split — so both are tried rather than only documenting the more specific folder. Returns
 *  null (never throws) if neither exists; WingLog only ever targets MSFS 2024, so no other
 *  sibling is tried. */
export async function resolvePackageDir(folderPath: string, packageName: string): Promise<string | null> {
  const candidates = [join(folderPath, packageName), join(folderPath, 'MSFS2024', packageName)]
  for (const candidate of candidates) {
    try {
      const stats = await stat(candidate)
      if (stats.isDirectory()) return candidate
    } catch {
      continue
    }
  }
  return null
}
