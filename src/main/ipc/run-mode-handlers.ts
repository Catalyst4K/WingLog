/**
 * Run mode IPC (winglog-backend's docs/plans/multi-device.md, Part 1): what this run of the app is, and the choice for the next launch.
 * The run mode is settled once at startup, so the capabilities do not change while the app is open; a new choice applies after a restart.
 */
import type { IpcMain } from 'electron'
import { IpcChannels } from '@shared/ipc'
import { parseRunMode, type AppCapabilities } from '@shared/run-mode'
import type { WingLogDb } from '../db/client'
import type { UseAnotherPcSimResult } from '@shared/ipc'
import { getRunMode, setOpenConnectOnStart, setRunMode, takeOpenConnectOnStart } from '../db/settings-repo'

/**
 * Registers the run mode channels.
 *
 * @param ipcMain Electron's IPC.
 * @param deps The database, what this run was started as, whether a flight is being tracked, and how to start the app again.
 * @param deps.capabilities What this run is, decided at startup (see `appCapabilities`).
 * @param deps.flightActive Whether a flight is being tracked now: a restart would end it, so it is refused.
 * @param deps.relaunch Starts the app again through a normal quit (`app.relaunch()` then `app.quit()`), so every quit step runs.
 */
export function registerRunModeHandlers(
  ipcMain: IpcMain,
  {
    db,
    capabilities,
    flightActive,
    relaunch
  }: { db: WingLogDb; capabilities: AppCapabilities; flightActive: () => boolean; relaunch: () => void }
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
  // Add a device → "Use another PC's sim" → Restart now, on a sim PC (devices-page.md, decided 2026-11-27): the switch and the restart
  // are one step, so closing the dialog changes nothing, and a tracked flight is never ended by it.
  ipcMain.handle(IpcChannels.appUseAnotherPcSimAndRestart, (): UseAnotherPcSimResult => {
    if (!capabilities.multiDevice || capabilities.runMode !== 'host')
      throw new Error('Only a sim PC in a multi-device build can switch to another PC’s sim')
    if (flightActive()) return 'flight-active'
    setRunMode(db, 'client')
    setOpenConnectOnStart(db)
    relaunch()
    return 'restarting'
  })
  // Read and cleared on every start, and acted on only by a client, so a request left behind can't send a sim PC to Devices.
  ipcMain.handle(
    IpcChannels.appTakeOpenConnectOnStart,
    () => takeOpenConnectOnStart(db) && capabilities.runMode === 'client'
  )
}
