/**
 * Run mode IPC (winglog-backend's docs/plans/multi-device.md, Part 1): what this run of the app is, and the choice for the next launch.
 * The run mode is settled once at startup, so the capabilities do not change while the app is open; a new choice applies after a restart.
 */
import type { IpcMain } from 'electron'
import { IpcChannels } from '@shared/ipc'
import { parseRunMode, type AppCapabilities } from '@shared/run-mode'
import type { WingLogDb } from '../db/client'
import { getRunMode, setRunMode } from '../db/settings-repo'

/**
 * Registers the run mode channels.
 *
 * @param ipcMain Electron's IPC.
 * @param deps The database and what this run was started as.
 * @param deps.capabilities What this run is, decided at startup (see `appCapabilities`).
 */
export function registerRunModeHandlers(
  ipcMain: IpcMain,
  { db, capabilities }: { db: WingLogDb; capabilities: AppCapabilities }
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
}
