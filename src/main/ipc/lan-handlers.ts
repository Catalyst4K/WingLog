/**
 * Device server IPC (Settings → Devices; winglog-backend's docs/plans/lan-web-viewer.md and devices-page.md): switching the server on,
 * choosing its port, pairing a device, renaming one and revoking one. All of it is local to this machine: a paired device can never reach these
 * channels, which are not in the remote command tables (`live/commands.ts`).
 */
import type { IpcMain } from 'electron'
import { IpcChannels } from '@shared/ipc'
import type { LanController } from '../lan/LanController'

/**
 * Registers the second-screen channels.
 *
 * @param ipcMain Electron's IPC.
 * @param deps The controller that runs the server.
 */
export function registerLanHandlers(ipcMain: IpcMain, { lan }: { lan: LanController }): void {
  ipcMain.handle(IpcChannels.lanGetStatus, () => lan.getStatus())
  ipcMain.handle(IpcChannels.lanSetSettings, (_event, settings: unknown) => lan.applySettings(settings))
  ipcMain.handle(IpcChannels.lanStartPairing, (_event, kind?: unknown) => lan.startPairing(kind))
  ipcMain.handle(IpcChannels.lanStopPairing, (_event, kind?: unknown) => lan.stopPairing(kind))
  ipcMain.handle(IpcChannels.lanRevokeDevice, (_event, id: unknown) => lan.revokeDevice(id))
  ipcMain.handle(IpcChannels.lanRenameDevice, (_event, id: unknown, name: unknown) =>
    lan.renameDevice(id, name)
  )
}
