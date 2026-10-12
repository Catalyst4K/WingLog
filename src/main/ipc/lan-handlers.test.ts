import { describe, expect, it, vi } from 'vitest'
import { IpcChannels } from '@shared/ipc'
import type { LanController } from '../lan/LanController'
import { fakeIpc } from './fake-ipc'
import { registerLanHandlers } from './lan-handlers'

describe('registerLanHandlers', () => {
  it('passes each channel to the controller, leaving the checking of input to it', async () => {
    const lan = {
      getStatus: vi.fn(() => 'status'),
      applySettings: vi.fn(() => Promise.resolve('applied')),
      startPairing: vi.fn(() => 'pairing'),
      stopPairing: vi.fn(() => 'stopped'),
      revokeDevice: vi.fn(() => 'revoked')
    }
    const ipc = fakeIpc()
    registerLanHandlers(ipc.ipcMain, { lan: lan as unknown as LanController })
    expect(ipc.invoke(IpcChannels.lanGetStatus)).toBe('status')
    await expect(ipc.invoke(IpcChannels.lanSetSettings, { enabled: true })).resolves.toBe('applied')
    expect(lan.applySettings).toHaveBeenCalledWith({ enabled: true })
    expect(ipc.invoke(IpcChannels.lanStartPairing)).toBe('pairing')
    expect(ipc.invoke(IpcChannels.lanStopPairing)).toBe('stopped')
    expect(ipc.invoke(IpcChannels.lanRevokeDevice, 3)).toBe('revoked')
    expect(lan.revokeDevice).toHaveBeenCalledWith(3)
  })
})
