import { describe, expect, it, vi } from 'vitest'
import { IpcChannels } from '@shared/ipc'
import { fakeIpc } from './fake-ipc'
import { registerWindowHandlers } from './window-handlers'

describe('window IPC handlers', () => {
  it('passes a true answer on as close, and anything else as keep open', () => {
    const answer = vi.fn()
    const ipc = fakeIpc()
    registerWindowHandlers(ipc.ipcMain, { closeQuestion: { answer } })
    ipc.invoke(IpcChannels.closeConfirmAnswer, true)
    expect(answer).toHaveBeenLastCalledWith(true)
    for (const value of [false, 'true', 1, null, undefined]) {
      ipc.invoke(IpcChannels.closeConfirmAnswer, value)
      expect(answer).toHaveBeenLastCalledWith(false)
    }
  })
})
