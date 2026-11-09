import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createDb, type WingLogDb } from '../db/client'
import { getLastSyncCompletedAt } from '../db/settings-repo'
import type { StoredSession } from '../backend/session-store'
import type { SyncResult } from './sync-engine'
import { CloudSyncController } from './cloud-sync-controller'

const {
  forgotPassword,
  resetPassword,
  backupBeforeFirstSync,
  saveSession,
  clearSession,
  login,
  logout,
  deleteAccount,
  provision,
  runCursorSync,
  resetPeer
} = vi.hoisted(() => ({
  deleteAccount: vi.fn(),
  forgotPassword: vi.fn(),
  resetPassword: vi.fn(),
  backupBeforeFirstSync: vi.fn(),
  saveSession: vi.fn(),
  clearSession: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  provision: vi.fn(),
  runCursorSync: vi.fn(),
  resetPeer: vi.fn()
}))

vi.mock('../backend/session-store', () => ({ saveSession, clearSession }))
vi.mock('../backend/sync-client', () => ({
  CLOUD_SYNC_TABLES: ['aircraft', 'flight', 'landing', 'flightInvoice', 'gsxRoutine'],
  login,
  logout,
  deleteAccount,
  forgotPassword,
  resetPassword,
  provision,
  syncPullPage: vi.fn(),
  syncPush: vi.fn()
}))
vi.mock('../db/backup', () => ({ backupBeforeFirstSync }))
vi.mock('./cursor-sync', () => ({ runCursorSync, resetPeer }))

const SESSION: StoredSession = {
  email: 'callum.jones5@btinternet.com',
  token: 'test-token',
  expiresAt: '2099-01-01T00:00:00.000Z'
}

describe('CloudSyncController', () => {
  let db: WingLogDb
  // What main/index.ts loads from disk at startup and hands to the constructor.
  let loaded: StoredSession | null

  beforeEach(() => {
    const created = createDb(':memory:')
    migrate(created.db, { migrationsFolder: 'drizzle' })
    db = created.db
    loaded = null
    saveSession.mockReset().mockResolvedValue(undefined)
    clearSession.mockReset()
    login.mockReset()
    logout.mockReset().mockResolvedValue(undefined)
    deleteAccount.mockReset().mockResolvedValue(undefined)
    forgotPassword.mockReset().mockResolvedValue(undefined)
    resetPassword.mockReset().mockResolvedValue(undefined)
    provision.mockReset()
    runCursorSync.mockReset()
    backupBeforeFirstSync.mockReset().mockReturnValue('/fake/userdata/backups/before-first-sync-1.db')
  })

  it('reports logged-out status with no prior session on disk', () => {
    const controller = new CloudSyncController(db, '/fake/db/path', '/fake/userdata', loaded)
    expect(controller.getStatus()).toEqual({
      loggedIn: false,
      email: null,
      syncing: false,
      lastSyncedAt: null,
      lastError: null
    })
  })

  it('restores a previously saved session and last-synced timestamp on construction', () => {
    loaded = SESSION
    const controller = new CloudSyncController(db, '/fake/db/path', '/fake/userdata', loaded)
    expect(controller.getStatus().loggedIn).toBe(true)
    expect(controller.getStatus().email).toBe(SESSION.email)
  })

  it('logs in, saving the session and clearing any prior error', async () => {
    login.mockResolvedValue({ token: SESSION.token, expiresAt: SESSION.expiresAt })
    const controller = new CloudSyncController(db, '/fake/db/path', '/fake/userdata', loaded)

    const status = await controller.login(SESSION.email, 'password123')

    expect(login).toHaveBeenCalledWith(SESSION.email, 'password123')
    expect(saveSession).toHaveBeenCalledWith('/fake/userdata', SESSION)
    expect(status.loggedIn).toBe(true)
    expect(status.email).toBe(SESSION.email)
  })

  it('fails the login, and stays signed out, when the session cannot be saved', async () => {
    login.mockResolvedValue({ token: SESSION.token, expiresAt: SESSION.expiresAt })
    saveSession.mockRejectedValue(new Error('encryption is not available'))
    const controller = new CloudSyncController(db, '/fake/db/path', '/fake/userdata', loaded)

    await expect(controller.login(SESSION.email, 'password123')).rejects.toThrow(
      'encryption is not available'
    )
    expect(controller.getStatus().loggedIn).toBe(false)
  })

  it('provisions then logs in on signup', async () => {
    login.mockResolvedValue({ token: SESSION.token, expiresAt: SESSION.expiresAt })
    const controller = new CloudSyncController(db, '/fake/db/path', '/fake/userdata', loaded)

    await controller.signup(SESSION.email, 'password123', 'INVITE1')

    expect(provision).toHaveBeenCalledWith(SESSION.email, 'password123', 'INVITE1')
    expect(login).toHaveBeenCalledWith(SESSION.email, 'password123')
  })

  it('logs out, clearing the session and the last-synced timestamp even if the backend call fails', async () => {
    loaded = SESSION
    logout.mockRejectedValue(new Error('network down'))
    const controller = new CloudSyncController(db, '/fake/db/path', '/fake/userdata', loaded)

    const status = await controller.logout()

    expect(clearSession).toHaveBeenCalledWith('/fake/userdata')
    expect(status).toEqual({
      loggedIn: false,
      email: null,
      syncing: false,
      lastSyncedAt: null,
      lastError: null
    })
    expect(getLastSyncCompletedAt(db)).toBeNull()
  })

  describe('a forgotten password', () => {
    it('asks for the code without needing a session', async () => {
      const controller = new CloudSyncController(db, '/fake/db/path', '/fake/userdata', null)
      await controller.forgotPassword('pilot@example.com')
      expect(forgotPassword).toHaveBeenCalledWith('pilot@example.com')
    })

    it('signs this computer out when the account it was signed in to has a new password (the service signs every device out)', async () => {
      loaded = SESSION
      const controller = new CloudSyncController(db, '/fake/db/path', '/fake/userdata', loaded)
      const status = await controller.resetPassword(
        ' Callum.Jones5@BTinternet.com ',
        'ABCD2345',
        'a brand new password'
      )
      expect(resetPassword).toHaveBeenCalledWith(
        ' Callum.Jones5@BTinternet.com ',
        'ABCD2345',
        'a brand new password'
      )
      expect(clearSession).toHaveBeenCalledWith('/fake/userdata')
      expect(status.loggedIn).toBe(false)
    })

    it('leaves a session for another account alone', async () => {
      loaded = SESSION
      const controller = new CloudSyncController(db, '/fake/db/path', '/fake/userdata', loaded)
      const status = await controller.resetPassword(
        'someone.else@example.com',
        'ABCD2345',
        'a brand new password'
      )
      expect(clearSession).not.toHaveBeenCalled()
      expect(status.loggedIn).toBe(true)
    })

    it('fails, and changes nothing here, when the code is refused', async () => {
      loaded = SESSION
      resetPassword.mockRejectedValue(new Error('invalid or expired code'))
      const controller = new CloudSyncController(db, '/fake/db/path', '/fake/userdata', loaded)
      await expect(
        controller.resetPassword(SESSION.email, 'WRONG234', 'a brand new password')
      ).rejects.toThrow('invalid or expired code')
      expect(clearSession).not.toHaveBeenCalled()
    })
  })

  describe('deleting the account', () => {
    it('deletes it on the service with the password, then signs out and forgets the cloud cursors', async () => {
      loaded = SESSION
      const controller = new CloudSyncController(db, '/fake/db/path', '/fake/userdata', loaded)

      const status = await controller.deleteAccount('the password')

      expect(deleteAccount).toHaveBeenCalledWith(SESSION.email, 'the password')
      expect(clearSession).toHaveBeenCalledWith('/fake/userdata')
      expect(status.loggedIn).toBe(false)
      expect(resetPeer).toHaveBeenCalledWith(db, 'cloud')
    })

    it('stays signed in, and deletes nothing here, when the service refuses', async () => {
      loaded = SESSION
      deleteAccount.mockRejectedValue(new Error('invalid email or password'))
      const controller = new CloudSyncController(db, '/fake/db/path', '/fake/userdata', loaded)

      await expect(controller.deleteAccount('wrong')).rejects.toThrow('invalid email or password')

      expect(clearSession).not.toHaveBeenCalled()
      expect(controller.getStatus().loggedIn).toBe(true)
      expect(resetPeer).not.toHaveBeenCalled()
    })

    it('refuses when not signed in, without calling the service', async () => {
      const controller = new CloudSyncController(db, '/fake/db/path', '/fake/userdata', null)
      await expect(controller.deleteAccount('x')).rejects.toThrow()
      expect(deleteAccount).not.toHaveBeenCalled()
    })
  })

  it('refuses to sync when not logged in', async () => {
    const controller = new CloudSyncController(db, '/fake/db/path', '/fake/userdata', loaded)
    await expect(controller.syncNow()).rejects.toThrow('Not logged in')
    expect(runCursorSync).not.toHaveBeenCalled()
  })

  it('runs a sync and records the completion time', async () => {
    loaded = SESSION
    const result: SyncResult = {
      syncedAt: '2026-09-11T12:00:00.000Z',
      tables: {} as SyncResult['tables']
    }
    runCursorSync.mockResolvedValue(result)
    const controller = new CloudSyncController(db, '/fake/db/path', '/fake/userdata', loaded)

    const status = await controller.syncNow()

    // The cloud is given every table the Worker takes, the GSX routines included.
    expect(runCursorSync).toHaveBeenCalledWith(db, expect.any(Object), SESSION, '/fake/db/path', 'cloud', [
      'aircraft',
      'flight',
      'landing',
      'flightInvoice',
      'gsxRoutine'
    ])
    expect(status.syncing).toBe(false)
    expect(status.lastSyncedAt).toBe('2026-09-11T12:00:00.000Z')
    expect(status.lastError).toBeNull()
    expect(getLastSyncCompletedAt(db)).toBe('2026-09-11T12:00:00.000Z')
  })

  it('does not start a second sync while one is already running', async () => {
    loaded = SESSION
    let resolveSync: (result: SyncResult) => void = () => {}
    runCursorSync.mockReturnValue(
      new Promise<SyncResult>((resolve) => {
        resolveSync = resolve
      })
    )
    const controller = new CloudSyncController(db, '/fake/db/path', '/fake/userdata', loaded)

    const first = controller.syncNow()
    const secondStatus = await controller.syncNow()

    expect(secondStatus.syncing).toBe(true)
    expect(runCursorSync).toHaveBeenCalledTimes(1)
    resolveSync({ syncedAt: '2026-09-11T12:00:00.000Z', tables: {} as SyncResult['tables'] })
    await first
  })

  it('records a sync failure and surfaces it in status without clearing the session', async () => {
    loaded = SESSION
    runCursorSync.mockRejectedValue(new Error('server unreachable'))
    const controller = new CloudSyncController(db, '/fake/db/path', '/fake/userdata', loaded)

    const status = await controller.syncNow()

    expect(status.syncing).toBe(false)
    expect(status.lastError).toBe('server unreachable')
    expect(status.loggedIn).toBe(true)
  })

  it('clears the session when a sync fails because it is invalid or expired', async () => {
    loaded = SESSION
    runCursorSync.mockRejectedValue(new Error('invalid or expired session'))
    const controller = new CloudSyncController(db, '/fake/db/path', '/fake/userdata', loaded)

    const status = await controller.syncNow()

    expect(status.loggedIn).toBe(false)
    expect(clearSession).toHaveBeenCalledWith('/fake/userdata')
  })

  describe("backup before an account's first sync", () => {
    const okResult = { syncedAt: '2026-09-11T12:00:00.000Z', tables: {} as SyncResult['tables'] }

    it('snapshots the database once, before the first sync runs', async () => {
      loaded = SESSION
      const order: string[] = []
      backupBeforeFirstSync.mockImplementation(() => {
        order.push('backup')
        return '/fake/userdata/backups/before-first-sync-1.db'
      })
      runCursorSync.mockImplementation(async () => {
        order.push('sync')
        return okResult
      })
      const controller = new CloudSyncController(db, '/fake/db/path', '/fake/userdata', loaded)

      await controller.syncNow()
      await controller.syncNow()

      expect(order).toEqual(['backup', 'sync', 'sync'])
      expect(backupBeforeFirstSync).toHaveBeenCalledWith('/fake/db/path', join('/fake/userdata', 'backups'))
    })

    it('forgets the cursors of the account before it, once, so a new account is sent everything', async () => {
      loaded = SESSION
      runCursorSync.mockResolvedValue(okResult)
      const controller = new CloudSyncController(db, '/fake/db/path', '/fake/userdata', loaded)

      await controller.syncNow()
      expect(resetPeer).toHaveBeenCalledTimes(1)
      expect(resetPeer).toHaveBeenCalledWith(db, 'cloud')

      // What a sync leaves behind is kept by the next one: the account is no longer new.
      await controller.syncNow()
      expect(resetPeer).toHaveBeenCalledTimes(1)
    })

    it('does not sync, and tries again next time, when the snapshot fails', async () => {
      loaded = SESSION
      backupBeforeFirstSync.mockImplementationOnce(() => {
        throw new Error('disk full')
      })
      runCursorSync.mockResolvedValue(okResult)
      const controller = new CloudSyncController(db, '/fake/db/path', '/fake/userdata', loaded)

      const failed = await controller.syncNow()
      expect(runCursorSync).not.toHaveBeenCalled()
      expect(failed.lastError).toBe('disk full')

      await controller.syncNow()
      expect(backupBeforeFirstSync).toHaveBeenCalledTimes(2)
      expect(runCursorSync).toHaveBeenCalledTimes(1)
    })
  })
})
