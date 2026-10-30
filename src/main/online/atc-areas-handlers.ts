/**
 * Starts the ATC areas' own update and registers its three channels (winglog-backend docs/plans/atc-areas-auto-update.md): the status
 * Settings shows, the switch, and Check now. All three are queries (coding-standards.md §9): they read or write this device's own settings
 * and cache. The renderer is not a security boundary, so the switch is checked here.
 */
import { renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IpcMain } from 'electron'
import { IpcChannels } from '@shared/ipc'
import type { WingLogDb } from '../db/client'
import { getSetting, setSetting } from '../db/settings-repo'
import { readTextUpTo } from '../files/read-text-up-to'
import { logger } from '../logging/logger'
import type { AreaData } from './atc-areas'
import { AtcAreasUpdater } from './atc-areas-updater'
import { downloadAreaFile, latestReleases, type AreaSource } from './atc-areas-download'
import { bundledAtcAreas } from './bundled-atc-areas'
import { feedUserAgent } from './feed-urls'
import { getOnlineNetworkSettings } from './online-settings'

const AUTO_KEY = 'atcAreasAuto'
const CHECKED_KEY = 'atcAreasCheckedAt'
/** The app's own copy, in WingLog's data folder. */
const FILE_NAME = 'atc-areas.json'
/** The most the copy may be when read back: the bundled file is 2.5 MB. */
const MAX_COPY_BYTES = 16 * 1024 * 1024

/** What the handlers need from the app. */
export interface AtcAreasHandlerDeps {
  db: WingLogDb
  /** WingLog's data folder. */
  userDataDir: string
  appVersion: string
  /** Where the releases are: GitHub, or the end-to-end test's server. */
  source: AreaSource
}

/**
 * @param path The copy's path.
 * @returns Its text, or null when it is not there, is too big or cannot be read.
 */
function readCopy(path: string): string | null {
  return readTextUpTo(path, MAX_COPY_BYTES)
}

/**
 * Writes the copy through a temporary file, so a half-written file is never read.
 *
 * @param path The copy's path.
 * @param text What to write.
 */
function writeCopy(path: string, text: string): void {
  const temporary = `${path}.tmp`
  writeFileSync(temporary, text)
  renameSync(temporary, path)
}

/**
 * Starts the update schedule and registers the channels.
 *
 * @param ipcMain Electron's IPC.
 * @param deps The database, the data folder, the app's version and where the releases are.
 * @returns The areas in use now (what the feed service draws) and `stop`, to end the schedule on quit.
 */
export function registerAtcAreas(
  ipcMain: IpcMain,
  deps: AtcAreasHandlerDeps
): { current: () => AreaData | null; stop: () => void } {
  const { db } = deps
  const path = join(deps.userDataDir, FILE_NAME)
  const userAgent = feedUserAgent(deps.appVersion)
  const updater = new AtcAreasUpdater({
    bundled: bundledAtcAreas,
    file: { read: () => readCopy(path), write: (text) => writeCopy(path, text) },
    settings: {
      auto: () => getSetting(db, AUTO_KEY) !== '0',
      setAuto: (on) => setSetting(db, AUTO_KEY, on ? '1' : '0'),
      checkedAt: () => getSetting(db, CHECKED_KEY) ?? null,
      setCheckedAt: (iso) => setSetting(db, CHECKED_KEY, iso)
    },
    networkChosen: () => getOnlineNetworkSettings(db).network !== null,
    latestReleases: () => latestReleases(deps.source, (url, init) => fetch(url, init), userAgent),
    download: downloadAreaFile,
    now: () => new Date(),
    timers: {
      set: (callback, ms) => setTimeout(callback, ms),
      clear: (handle) => clearTimeout(handle as NodeJS.Timeout)
    },
    log: logger
  })
  ipcMain.handle(IpcChannels.atcAreasGetStatus, () => updater.status())
  ipcMain.handle(IpcChannels.atcAreasSetAuto, (_event, on: unknown) =>
    typeof on === 'boolean' ? updater.setAuto(on) : updater.status()
  )
  ipcMain.handle(IpcChannels.atcAreasCheckNow, () => updater.check(true))
  updater.start()
  return { current: updater.current, stop: () => updater.stop() }
}
