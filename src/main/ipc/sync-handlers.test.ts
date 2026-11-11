import { afterEach, describe, expect, it, vi } from 'vitest'
import { IpcChannels } from '@shared/ipc'
import type { CloudSyncController } from '../sync/cloud-sync-controller'
import { fakeIpc } from './fake-ipc'
import {
  BACKGROUND_SYNC_DELAY_MS,
  PERIODIC_SYNC_INTERVAL_MS,
  createBackgroundSync,
  registerSyncHandlers,
  startPeriodicSync
} from './sync-handlers'

/** A sync controller, signed in or out. */
function fakeCloudSync(loggedIn: boolean): Record<string, ReturnType<typeof vi.fn>> {
  return {
    getStatus: vi.fn(() => ({ loggedIn })),
    syncNow: vi.fn(() => Promise.resolve()),
    login: vi.fn(),
    signup: vi.fn(),
    logout: vi.fn(),
    deleteAccount: vi.fn(),
    forgotPassword: vi.fn(),
    resetPassword: vi.fn()
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

describe('startPeriodicSync', () => {
  afterEach(() => vi.useRealTimers())

  it('syncs every interval while signed in, and stops when told to', () => {
    vi.useFakeTimers()
    const cloudSync = fakeCloudSync(true)
    const stop = startPeriodicSync(cloudSync as unknown as CloudSyncController)
    vi.advanceTimersByTime(PERIODIC_SYNC_INTERVAL_MS * 2)
    expect(cloudSync.syncNow).toHaveBeenCalledTimes(2)
    stop()
    vi.advanceTimersByTime(PERIODIC_SYNC_INTERVAL_MS)
    expect(cloudSync.syncNow).toHaveBeenCalledTimes(2)
  })

  it('does nothing while signed out', () => {
    vi.useFakeTimers()
    const cloudSync = fakeCloudSync(false)
    startPeriodicSync(cloudSync as unknown as CloudSyncController)
    vi.advanceTimersByTime(PERIODIC_SYNC_INTERVAL_MS * 3)
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
      IpcChannels.authDeleteAccount,
      IpcChannels.authForgotPassword,
      IpcChannels.authResetPassword,
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
    invoke(IpcChannels.authDeleteAccount, 'secret')
    invoke(IpcChannels.syncNow)
    expect(invoke(IpcChannels.syncStatus)).toEqual({ loggedIn: true })
    expect(cloudSync.login).toHaveBeenCalledWith('pilot@example.com', 'secret')
    expect(cloudSync.signup).toHaveBeenCalledWith('pilot@example.com', 'secret', 'INVITE')
    expect(cloudSync.logout).toHaveBeenCalled()
    expect(cloudSync.deleteAccount).toHaveBeenCalledWith('secret')
    expect(cloudSync.syncNow).toHaveBeenCalled()
  })

  it('refuses sign-in and sign-up arguments that are not text of a sensible length, before the controller is called (audit L7)', () => {
    const cloudSync = fakeCloudSync(true)
    const { ipcMain, invoke } = fakeIpc()
    registerSyncHandlers(ipcMain, { cloudSync: cloudSync as unknown as CloudSyncController, enabled: true })
    for (const bad of [undefined, null, 5, {}, '', 'x'.repeat(255)]) {
      expect(() => invoke(IpcChannels.authLogin, bad, 'secret')).toThrow('Invalid email')
      expect(() => invoke(IpcChannels.authSignup, bad, 'secret', 'INVITE')).toThrow('Invalid email')
    }
    for (const bad of [undefined, null, 5, {}, '', 'x'.repeat(1025)]) {
      expect(() => invoke(IpcChannels.authLogin, 'pilot@example.com', bad)).toThrow('Invalid password')
      expect(() => invoke(IpcChannels.authSignup, 'pilot@example.com', bad, 'INVITE')).toThrow(
        'Invalid password'
      )
    }
    for (const bad of [undefined, 5, '', 'x'.repeat(513)]) {
      expect(() => invoke(IpcChannels.authSignup, 'pilot@example.com', 'secret', bad)).toThrow(
        'Invalid invite code'
      )
    }
    expect(cloudSync.login).not.toHaveBeenCalled()
    expect(cloudSync.signup).not.toHaveBeenCalled()
    // The longest values the service takes are passed on.
    invoke(IpcChannels.authLogin, 'x'.repeat(254), 'p'.repeat(1024))
    invoke(IpcChannels.authSignup, 'x'.repeat(254), 'p'.repeat(1024), 'i'.repeat(512))
    expect(cloudSync.login).toHaveBeenCalledTimes(1)
    expect(cloudSync.signup).toHaveBeenCalledTimes(1)
  })

  it('passes a password reset request and the reset itself to the controller, and refuses what is not text of a sensible length', () => {
    const cloudSync = fakeCloudSync(true)
    const { ipcMain, invoke } = fakeIpc()
    registerSyncHandlers(ipcMain, { cloudSync: cloudSync as unknown as CloudSyncController, enabled: true })
    invoke(IpcChannels.authForgotPassword, 'pilot@example.com')
    invoke(IpcChannels.authResetPassword, 'pilot@example.com', 'ABCD2345', 'a brand new password')
    expect(cloudSync.forgotPassword).toHaveBeenCalledWith('pilot@example.com')
    expect(cloudSync.resetPassword).toHaveBeenCalledWith(
      'pilot@example.com',
      'ABCD2345',
      'a brand new password'
    )
    expect(() => invoke(IpcChannels.authForgotPassword, '')).toThrow('Invalid email')
    expect(() => invoke(IpcChannels.authForgotPassword, 'x'.repeat(255))).toThrow('Invalid email')
    expect(() => invoke(IpcChannels.authResetPassword, 'a@b.com', 5, 'a brand new password')).toThrow(
      'Invalid code'
    )
    expect(() => invoke(IpcChannels.authResetPassword, 'a@b.com', 'x'.repeat(33), 'p')).toThrow(
      'Invalid code'
    )
    expect(() => invoke(IpcChannels.authResetPassword, 'a@b.com', 'ABCD2345', undefined)).toThrow(
      'Invalid password'
    )
    expect(cloudSync.forgotPassword).toHaveBeenCalledTimes(1)
    expect(cloudSync.resetPassword).toHaveBeenCalledTimes(1)
  })

  it('refuses to delete the account for a password that is not a text of a sensible length', () => {
    const cloudSync = fakeCloudSync(true)
    const { ipcMain, invoke } = fakeIpc()
    registerSyncHandlers(ipcMain, { cloudSync: cloudSync as unknown as CloudSyncController, enabled: true })
    for (const bad of [undefined, 5, '', 'x'.repeat(1025)]) {
      expect(() => invoke(IpcChannels.authDeleteAccount, bad)).toThrow('Invalid password')
    }
    expect(cloudSync.deleteAccount).not.toHaveBeenCalled()
  })
})
