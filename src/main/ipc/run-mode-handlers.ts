/**
 * Run mode IPC (winglog-backend's docs/plans/multi-device.md, Part 1): what this run of the app is, and the choice for the next launch.
 * The run mode is settled once at startup, so the capabilities do not change while the app is open; a new choice applies after a restart.
 */
import type { IpcMain } from 'electron'
import { IpcChannels } from '@shared/ipc'
import { parseRunMode, type AppCapabilities } from '@shared/run-mode'
import type { WingLogDb } from '../db/client'
import { getRunMode, setOpenConnectOnStart, setRunMode, takeOpenConnectOnStart } from '../db/settings-repo'

/**
 * Registers the run mode channels.
 *
 * @param ipcMain Electron's IPC.
 * @param deps The database, what this run was started as, and how to start the app again.
 * @param deps.capabilities What this run is, decided at startup (see `appCapabilities`).
 * @param deps.relaunch Starts the app again and ends this run (`app.relaunch()` then `app.exit()`).
 */
export function registerRunModeHandlers(
  ipcMain: IpcMain,
  { db, capabilities, relaunch }: { db: WingLogDb; capabilities: AppCapabilities; relaunch: () => void }
): void {
  ipcMain.handle(IpcChannels.appGetCapabilities, () => capabilities)
  ipcMain.handle(IpcChannels.settingsGetRunMode, () => getRunMode(db))
  ipcMain.handle(IpcChannels.settingsSetRunMode, (_event, value: unknown) => {
    // A release build offers no choice, and a computer that cannot host the sim can only be a client: both are refused here, not just
    // hidden in the Settings page, because the renderer is not a security boundary.
    if (!capabilities.multiDevice) throw new Error('The run mode cannot be changed in this build')
    const mode = parseRunMode(typeof value === 'string' ? value : null)
    if (!mode) throw new Error('Unknown run mode')
    if (mode === 'host' && !capabilities.canHostSim) throw new Error('This computer cannot be the sim host')
    setRunMode(db, mode)
  })
  // Add a device → "Use another PC's sim", on a sim PC that could be a client instead (devices-page.md, 2026-11-23).
  ipcMain.handle(IpcChannels.settingsUseAnotherPcSim, () => {
    if (!capabilities.multiDevice || capabilities.runMode !== 'host')
      throw new Error('Only a sim PC in a multi-device build can switch to another PC’s sim')
    setRunMode(db, 'client')
    setOpenConnectOnStart(db)
  })
  // A restart is allowed only when it is needed: the run mode chosen for the next launch is not this run's.
  ipcMain.handle(IpcChannels.appRestartForRunMode, () => {
    const chosen = getRunMode(db)
    if (!capabilities.multiDevice || chosen === null || chosen === capabilities.runMode)
      throw new Error('No run mode change is waiting for a restart')
    relaunch()
  })
  ipcMain.handle(IpcChannels.appTakeOpenConnectOnStart, () => takeOpenConnectOnStart(db))
}
