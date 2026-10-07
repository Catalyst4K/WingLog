import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMain } from 'electron'
import { IpcChannels } from '@shared/ipc'
import type { UpdateService } from '../updates/update-check'
import { MANUAL_FILENAME } from '../manual-path'
import { registerAppHandlers } from './app-handlers'

const appPath = mkdtempSync(join(tmpdir(), 'winglog-app-handlers-'))
const openExternal = vi.fn()
const openPath = vi.fn()
vi.mock('electron', () => ({
  app: { getVersion: () => '1.4.1', isPackaged: false, getAppPath: () => appPath },
  shell: { openExternal: (url: string) => openExternal(url), openPath: (path: string) => openPath(path) }
}))

/** An ipcMain that records handlers, and calls them as the renderer would. */
function fakeIpc(): { ipcMain: IpcMain; invoke: (channel: string, ...args: unknown[]) => unknown } {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ipcMain = {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
      handlers.set(channel, handler)
  }
  return {
    ipcMain: ipcMain as unknown as IpcMain,
    invoke: (channel, ...args) => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`No handler for ${channel}`)
      return handler({}, ...args)
    }
  }
}

describe('app IPC handlers', () => {
  const updateService = {
    getStatus: vi.fn(() => ({ state: 'idle' })),
    checkNow: vi.fn(),
    skipVersion: vi.fn(),
    releaseUrl: vi.fn<() => string | null>()
  }
  const { ipcMain, invoke } = fakeIpc()
  registerAppHandlers(ipcMain, { updateService: updateService as unknown as UpdateService })

  beforeEach(() => {
    openExternal.mockReset()
    openPath.mockReset()
  })

  it('reports the plain version outside the dev build, and opens the GitHub page', () => {
    expect(invoke(IpcChannels.appGetVersion)).toBe('1.4.1')
    invoke(IpcChannels.appOpenGithub)
    expect(openExternal).toHaveBeenCalledWith('https://github.com/Catalyst4K/WingLog')
  })

  it('opens the manual only when it has been built, and says whether it opened', async () => {
    expect(await invoke(IpcChannels.appOpenManual)).toBe(false)
    expect(openPath).not.toHaveBeenCalled()

    const manual = join(appPath, 'release', 'manual', MANUAL_FILENAME)
    mkdirSync(join(appPath, 'release', 'manual'), { recursive: true })
    writeFileSync(manual, '%PDF-1.4')
    openPath.mockResolvedValueOnce('').mockResolvedValueOnce('No application is associated')
    expect(await invoke(IpcChannels.appOpenManual)).toBe(true)
    expect(openPath).toHaveBeenCalledWith(manual)
    expect(await invoke(IpcChannels.appOpenManual)).toBe(false)
  })

  it('passes the update channels to the update service', () => {
    expect(invoke(IpcChannels.updatesGetStatus)).toEqual({ state: 'idle' })
    invoke(IpcChannels.updatesCheckNow)
    invoke(IpcChannels.updatesSkipVersion, '1.5.0')
    expect(updateService.checkNow).toHaveBeenCalled()
    expect(updateService.skipVersion).toHaveBeenCalledWith('1.5.0')
  })

  it('opens the release page only when there is one', async () => {
    updateService.releaseUrl
      .mockReturnValueOnce(null)
      .mockReturnValueOnce('https://github.com/Catalyst4K/WingLog/releases/tag/v1.5.0')
    await invoke(IpcChannels.updatesOpenRelease)
    expect(openExternal).not.toHaveBeenCalled()
    await invoke(IpcChannels.updatesOpenRelease)
    expect(openExternal).toHaveBeenCalledWith('https://github.com/Catalyst4K/WingLog/releases/tag/v1.5.0')
  })
})
