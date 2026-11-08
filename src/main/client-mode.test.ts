import { describe, expect, it } from 'vitest'
import { IpcChannels } from '@shared/ipc'
import { registerInertHandlers, trackHandledChannels } from './client-mode'
import { fakeIpc } from './ipc/fake-ipc'

describe('a client leaves the host-only services out', () => {
  it('sees every channel registered after it starts watching', () => {
    const { ipcMain } = fakeIpc()
    const handled = trackHandledChannels(ipcMain)
    ipcMain.handle(IpcChannels.appGetVersion, () => '1.7.0')
    expect(handled.has(IpcChannels.appGetVersion)).toBe(true)
    expect(handled.has(IpcChannels.syncNow)).toBe(false)
  })

  it('still calls the real handler it wraps', () => {
    const ipc = fakeIpc()
    trackHandledChannels(ipc.ipcMain)
    ipc.ipcMain.handle(IpcChannels.appGetVersion, () => '1.7.0')
    expect(ipc.invoke(IpcChannels.appGetVersion)).toBe('1.7.0')
  })

  it('answers each channel nothing registered, and leaves the registered ones alone', () => {
    const ipc = fakeIpc()
    const handled = trackHandledChannels(ipc.ipcMain)
    ipc.ipcMain.handle(IpcChannels.appGetVersion, () => '1.7.0')
    const answered = registerInertHandlers(ipc.ipcMain, handled)
    expect(answered).not.toContain(IpcChannels.appGetVersion)
    expect(ipc.invoke(IpcChannels.appGetVersion)).toBe('1.7.0')
    expect(answered).toContain(IpcChannels.lanGetStatus)
    expect(ipc.invoke(IpcChannels.lanGetStatus)).toBeUndefined()
  })

  it('reads the add-ons as switched off, so nothing is started or shown', () => {
    const ipc = fakeIpc()
    registerInertHandlers(ipc.ipcMain, new Set())
    expect(ipc.invoke(IpcChannels.settingsGetGsxRemote)).toMatchObject({ enabled: false })
    expect(ipc.invoke(IpcChannels.settingsGetBeyondAtc)).toMatchObject({ enabled: false })
    expect(ipc.invoke(IpcChannels.settingsGetOnlineNetwork)).toMatchObject({ network: null })
  })
})
