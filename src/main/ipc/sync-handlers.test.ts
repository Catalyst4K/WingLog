import { afterEach, describe, expect, it, vi } from 'vitest'
import { IpcChannels } from '@shared/ipc'
import type { CloudSyncController } from '../sync/cloud-sync-controller'
import { fakeIpc } from './fake-ipc'
import { BACKGROUND_SYNC_DELAY_MS, createBackgroundSync, registerSyncHandlers } from './sync-handlers'

/** A sync controller, signed in or out. */
function fakeCloudSync(loggedIn: boolean): Record<string, ReturnType<typeof vi.fn>> {
  return {
    getStatus: vi.fn(() => ({ loggedIn })),
    syncNow: vi.fn(() => Promise.resolve()),
    login: vi.fn(),
    signup: vi.fn(),
    logout: vi.fn()
  }
}

describe('createBackgroundSync', () => {
  afterEach(() => vi.useRealTimers())

  it('runs one sync after a burst of changes settles', () => {
    vi.useFakeTimers()
    const cloudSync = fakeCloudSync(true)
    const schedule = createBackgroundSync(cloudSync as unknown as CloudSyncController)
    schedule()
    vi.advanceTimersByTime(BACKGROUND_SYNC_DELAY_MS - 1)
    schedule()
    schedule()
    vi.advanceTimersByTime(BACKGROUND_SYNC_DELAY_MS - 1)
    expect(cloudSync.syncNow).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(cloudSync.syncNow).toHaveBeenCalledTimes(1)
  })

  it('does nothing while signed out', () => {
    vi.useFakeTimers()
    const cloudSync = fakeCloudSync(false)
    createBackgroundSync(cloudSync as unknown as CloudSyncController)()
    vi.runAllTimers()
    expect(cloudSync.syncNow).not.toHaveBeenCalled()
  })
})

describe('sync IPC handlers', () => {
  it("don't exist at all in a build without cloud sync", () => {
    const { ipcMain, has } = fakeIpc()
    registerSyncHandlers(ipcMain, {
      cloudSync: fakeCloudSync(false) as unknown as CloudSyncController,
      enabled: false
    })
    for (const channel of [
      IpcChannels.authLogin,
      IpcChannels.authSignup,
      IpcChannels.authLogout,
      IpcChannels.syncNow,
      IpcChannels.syncStatus
    ]) {
      expect(has(channel), channel).toBe(false)
    }
  })

  it('pass sign-in, sign-up, sign-out and sync to the controller in a build with it', () => {
    const cloudSync = fakeCloudSync(true)
    const { ipcMain, invoke } = fakeIpc()
    registerSyncHandlers(ipcMain, { cloudSync: cloudSync as unknown as CloudSyncController, enabled: true })
    invoke(IpcChannels.authLogin, 'pilot@example.com', 'secret')
    invoke(IpcChannels.authSignup, 'pilot@example.com', 'secret', 'INVITE')
    invoke(IpcChannels.authLogout)
    invoke(IpcChannels.syncNow)
    expect(invoke(IpcChannels.syncStatus)).toEqual({ loggedIn: true })
    expect(cloudSync.login).toHaveBeenCalledWith('pilot@example.com', 'secret')
    expect(cloudSync.signup).toHaveBeenCalledWith('pilot@example.com', 'secret', 'INVITE')
    expect(cloudSync.logout).toHaveBeenCalled()
    expect(cloudSync.syncNow).toHaveBeenCalled()
  })
})
