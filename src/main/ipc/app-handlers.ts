/**
 * App IPC: the version, the GitHub and manual links, renderer error logging, and the update check. The update channels are
 * queries of the UpdateService (coding-standards.md §9); the links open outside the app.
 */
import { app, shell, type IpcMain } from 'electron'
import { IpcChannels } from '@shared/ipc'
import type { UpdateService } from '../updates/update-check'
import { manualPath } from '../manual-path'
import { existsSync } from 'node:fs'
import { logger } from '../logging/logger'

/** The longest renderer context or message written to main.log, in characters. */
const MAX_RENDERER_LOG_CHARS = 2_000

/**
 * Cuts a renderer string to length and puts it on one line, so it can't add log lines of its own.
 *
 * @param text The renderer's text.
 * @returns At most MAX_RENDERER_LOG_CHARS characters, with every line break replaced by a space.
 */
function oneLine(text: string): string {
  return text.slice(0, MAX_RENDERER_LOG_CHARS).replace(/[\r\n\u2028\u2029]+/g, ' ')
}

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

  // A renderer failure, to main.log. Strings only, cut to length and on one line: the renderer
  // isn't trusted, and its text can carry third-party text that would otherwise forge log lines.
  ipcMain.handle(IpcChannels.appLogRendererError, (_event, context: unknown, message: unknown) => {
    if (typeof context !== 'string' || typeof message !== 'string') return
    logger.warn(`[renderer] ${oneLine(context)}: ${oneLine(message)}`)
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
