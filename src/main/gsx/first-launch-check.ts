import { existsSync } from 'node:fs'
import type { GsxFirstLaunchResult } from '@shared/ipc'
import type { WingLogDb } from '../db/client'
import { getGsxSettings, hasCheckedGsxFirstLaunch, setCheckedGsxFirstLaunch, setGsxSettings } from '../db/settings-repo'
import { defaultGsxReceiptsPath } from './default-path'

/**
 * Runs once, ever — gated by a stored flag rather than "every launch" or "first Settings
 * visit" — and checks whether GSX's expected receipts folder actually exists on disk
 * (flight-test-findings-2026-09-06.md #4). Found: auto-enables GSX against that folder,
 * since a receipts folder actually being there is as strong a signal as a user could give
 * without being asked. Not found: leaves GSX off (already the default), so there's
 * nothing to undo — the caller is expected to tell the user either way, since silently
 * flipping a feature on/off with no visible sign of it happening is the exact failure
 * mode this finding was raised against.
 *
 * Returns null on every call after the first — the one time this actually has something
 * to report, the flag hasn't been set yet; every later launch is a no-op check.
 */
export function checkGsxFirstLaunch(db: WingLogDb): GsxFirstLaunchResult | null {
  if (hasCheckedGsxFirstLaunch(db)) return null
  setCheckedGsxFirstLaunch(db)

  const path = defaultGsxReceiptsPath()
  const found = path !== null && existsSync(path)
  if (found && path) {
    setGsxSettings(db, { ...getGsxSettings(db), enabled: true, folderPath: path })
  }
  return { found }
}
