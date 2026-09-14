import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createDb, type WingLogDb } from '../db/client'
import { getLastSyncCompletedAt } from '../db/settings-repo'
import type { StoredSession } from '../backend/session-store'
import type { SyncResult } from './sync-engine'
import { CloudSyncController } from './cloud-sync-controller'

const { loadSession, saveSession, clearSession, login, logout, provision, runSync } = vi.hoisted(() => ({
  loadSession: vi.fn(),
  saveSession: vi.fn(),
  clearSession: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  provision: vi.fn(),
  runSync: vi.fn()
}))

vi.mock('../backend/session-store', () => ({ loadSession, saveSession, clearSession }))
vi.mock('../backend/sync-client', () => ({ login, logout, provision, syncPull: vi.fn(), syncPush: vi.fn() }))
vi.mock('./sync-engine', () => ({ runSync }))

const SESSION: StoredSession = {
  email: 'callum.jones5@btinternet.com',
  token: 'test-token',
  expiresAt: '2099-01-01T00:00:00.000Z'
}

describe('CloudSyncController', () => {
  let db: WingLogDb

  beforeEach(() => {
    const created = createDb(':memory:')
    migrate(created.db, { migrationsFolder: 'drizzle' })
    db = created.db
    loadSession.mockReset().mockReturnValue(null)
    saveSession.mockReset()
    clearSession.mockReset()
    login.mockReset()
    logout.mockReset().mockResolvedValue(undefined)
    provision.mockReset()
    runSync.mockReset()
  })

  it('reports logged-out status with no prior session on disk', () => {
    const controller = new CloudSyncController(db, '/fake/db/path', '/fake/userdata')
    expect(controller.getStatus()).toEqual({
      loggedIn: false,
      email: null,
      syncing: false,
      lastSyncedAt: null,
      lastError: null
    })
  })

  it('restores a previously saved session and last-synced timestamp on construction', () => {
    loadSession.mockReturnValue(SESSION)
    const controller = new CloudSyncController(db, '/fake/db/path', '/fake/userdata')
    expect(controller.getStatus().loggedIn).toBe(true)
    expect(controller.getStatus().email).toBe(SESSION.email)
  })

  it('logs in, saving the session and clearing any prior error', async () => {
    login.mockResolvedValue({ token: SESSION.token, expiresAt: SESSION.expiresAt })
    const controller = new CloudSyncController(db, '/fake/db/path', '/fake/userdata')

    const status = await controller.login(SESSION.email, 'password123')

    expect(login).toHaveBeenCalledWith(SESSION.email, 'password123')
    expect(saveSession).toHaveBeenCalledWith('/fake/userdata', SESSION)
    expect(status.loggedIn).toBe(true)
    expect(status.email).toBe(SESSION.email)
  })

  it('provisions then logs in on signup', async () => {
    login.mockResolvedValue({ token: SESSION.token, expiresAt: SESSION.expiresAt })
    const controller = new CloudSyncController(db, '/fake/db/path', '/fake/userdata')

    await controller.signup(SESSION.email, 'password123', 'INVITE1')

    expect(provision).toHaveBeenCalledWith(SESSION.email, 'password123', 'INVITE1')
    expect(login).toHaveBeenCalledWith(SESSION.email, 'password123')
  })

  it('logs out, clearing the session and the last-synced timestamp even if the backend call fails', async () => {
    loadSession.mockReturnValue(SESSION)
    logout.mockRejectedValue(new Error('network down'))
    const controller = new CloudSyncController(db, '/fake/db/path', '/fake/userdata')

    const status = await controller.logout()

    expect(clearSession).toHaveBeenCalledWith('/fake/userdata')
    expect(status).toEqual({ loggedIn: false, email: null, syncing: false, lastSyncedAt: null, lastError: null })
    expect(getLastSyncCompletedAt(db)).toBeNull()
  })

  it('refuses to sync when not logged in', async () => {
    const controller = new CloudSyncController(db, '/fake/db/path', '/fake/userdata')
    await expect(controller.syncNow()).rejects.toThrow('Not logged in')
    expect(runSync).not.toHaveBeenCalled()
  })

  it('runs a sync and records the completion time', async () => {
    loadSession.mockReturnValue(SESSION)
    const result: SyncResult = {
      syncedAt: '2026-09-11T12:00:00.000Z',
      tables: {} as SyncResult['tables']
    }
    runSync.mockResolvedValue(result)
    const controller = new CloudSyncController(db, '/fake/db/path', '/fake/userdata')

    const status = await controller.syncNow()

    expect(runSync).toHaveBeenCalledWith(db, expect.any(Object), SESSION, '/fake/db/path')
    expect(status.syncing).toBe(false)
    expect(status.lastSyncedAt).toBe('2026-09-11T12:00:00.000Z')
    expect(status.lastError).toBeNull()
    expect(getLastSyncCompletedAt(db)).toBe('2026-09-11T12:00:00.000Z')
  })

  it('does not start a second sync while one is already running', async () => {
    loadSession.mockReturnValue(SESSION)
    let resolveSync: (result: SyncResult) => void = () => {}
    runSync.mockReturnValue(
      new Promise<SyncResult>((resolve) => {
        resolveSync = resolve
      })
    )
    const controller = new CloudSyncController(db, '/fake/db/path', '/fake/userdata')

    const first = controller.syncNow()
    const secondStatus = await controller.syncNow()

    expect(secondStatus.syncing).toBe(true)
    expect(runSync).toHaveBeenCalledTimes(1)
    resolveSync({ syncedAt: '2026-09-11T12:00:00.000Z', tables: {} as SyncResult['tables'] })
    await first
  })

  it('records a sync failure and surfaces it in status without clearing the session', async () => {
    loadSession.mockReturnValue(SESSION)
    runSync.mockRejectedValue(new Error('server unreachable'))
    const controller = new CloudSyncController(db, '/fake/db/path', '/fake/userdata')

    const status = await controller.syncNow()

    expect(status.syncing).toBe(false)
    expect(status.lastError).toBe('server unreachable')
    expect(status.loggedIn).toBe(true)
  })

  it('clears the session when a sync fails because it is invalid or expired', async () => {
    loadSession.mockReturnValue(SESSION)
    runSync.mockRejectedValue(new Error('invalid or expired session'))
    const controller = new CloudSyncController(db, '/fake/db/path', '/fake/userdata')

    const status = await controller.syncNow()

    expect(status.loggedIn).toBe(false)
    expect(clearSession).toHaveBeenCalledWith('/fake/userdata')
  })
})
