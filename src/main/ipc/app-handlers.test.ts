import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IpcChannels } from '@shared/ipc'
import type { UpdateService } from '../updates/update-check'
import { MANUAL_FILENAME } from '../manual-path'
import { logger } from '../logging/logger'
import { registerAppHandlers } from './app-handlers'
import { fakeIpc } from './fake-ipc'

const appPath = mkdtempSync(join(tmpdir(), 'winglog-app-handlers-'))
const openExternal = vi.fn()
const openPath = vi.fn()
vi.mock('electron', () => ({
  app: { getVersion: () => '1.4.1', isPackaged: false, getAppPath: () => appPath },
  shell: { openExternal: (url: string) => openExternal(url), openPath: (path: string) => openPath(path) }
}))

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

  it('writes a renderer failure to main.log as a warning, strings only and cut to length', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    invoke(IpcChannels.appLogRendererError, 'fleet: save aircraft', 'Registration already in the fleet')
    expect(warn).toHaveBeenCalledWith('[renderer] fleet: save aircraft: Registration already in the fleet')
    invoke(IpcChannels.appLogRendererError, 'x'.repeat(5_000), { not: 'a string' })
    invoke(IpcChannels.appLogRendererError, 'long message', 'y'.repeat(5_000))
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenLastCalledWith(`[renderer] long message: ${'y'.repeat(2_000)}`)
    warn.mockRestore()
  })

  it('keeps a renderer failure on one log line, whatever line breaks its text carries', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    invoke(
      IpcChannels.appLogRendererError,
      'dispatch:\nfake',
      'SimBrief said:\r\n[beyondatc] InfoBoxes {} end'
    )
    expect(warn).toHaveBeenCalledWith(
      '[renderer] dispatch: fake: SimBrief said: [beyondatc] InfoBoxes {} end'
    )
    warn.mockRestore()
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
