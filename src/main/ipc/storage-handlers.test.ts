import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { IpcChannels, type StorageStatus } from '@shared/ipc'
import { registerStorageHandlers } from './storage-handlers'
import { fakeIpc } from './fake-ipc'

describe('storage IPC', () => {
  it('answers the first render with the current status and publishes each change to the live hub', () => {
    const status: StorageStatus = { freeBytes: 2e9, level: 'low', saveFailing: false }
    const monitor = Object.assign(new EventEmitter(), { getStatus: () => status })
    const publish = vi.fn()
    const { ipcMain, invoke } = fakeIpc()
    registerStorageHandlers(ipcMain, { monitor: monitor as never, liveHub: { publish } })

    expect(invoke(IpcChannels.storageGetStatus)).toEqual(status)
    const next: StorageStatus = { freeBytes: 5e8, level: 'critical', saveFailing: true }
    monitor.emit('status', next)
    expect(publish).toHaveBeenCalledWith('storageStatus', next)
  })
})
