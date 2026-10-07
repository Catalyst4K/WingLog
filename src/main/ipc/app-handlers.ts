/**
 * App IPC: the version, the GitHub and manual links, and the update check. The update channels are
 * queries of the UpdateService (coding-standards.md §9); the links open outside the app.
 */
import { app, shell, type IpcMain } from 'electron'
import { IpcChannels } from '@shared/ipc'
import type { UpdateService } from '../updates/update-check'
import { manualPath } from '../manual-path'
import { existsSync } from 'node:fs'

/**
 * Registers the app channels.
 *
 * @param ipcMain Electron's IPC.
 * @param deps The update service.
 */
export function registerAppHandlers(
  ipcMain: IpcMain,
  { updateService }: { updateService: UpdateService }
): void {
  // "-dev" marks the dev build in About and in bug reports; the update check compares the
  // plain version.
  ipcMain.handle(IpcChannels.appGetVersion, () =>
    __WINGLOG_DEV_BUILD__ ? `${app.getVersion()}-dev` : app.getVersion()
  )

  ipcMain.handle(IpcChannels.appOpenGithub, () => shell.openExternal('https://github.com/Catalyst4K/WingLog'))

  // The PDF manual: a fixed path inside the app's own resources, never one from the renderer.
  ipcMain.handle(IpcChannels.appOpenManual, async () => {
    const manual = manualPath(app.isPackaged, process.resourcesPath, app.getAppPath())
    if (!existsSync(manual)) return false
    return (await shell.openPath(manual)) === ''
  })

  ipcMain.handle(IpcChannels.updatesGetStatus, () => updateService.getStatus())

  ipcMain.handle(IpcChannels.updatesCheckNow, () => updateService.checkNow())

  ipcMain.handle(IpcChannels.updatesSkipVersion, (_event, version: unknown) =>
    updateService.skipVersion(version)
  )

  ipcMain.handle(IpcChannels.updatesOpenRelease, async () => {
    const url = updateService.releaseUrl()
    if (url) await shell.openExternal(url)
  })
}
