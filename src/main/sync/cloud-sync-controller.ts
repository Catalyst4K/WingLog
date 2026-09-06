/**
 * Owns cloud-sync's runtime state (docs/plans/cloud-sync.md) — the logged-in session, and
 * whether a sync is in progress — and is the one thing main/index.ts wires the IPC
 * channels to. Everything else (session persistence, the wire protocol, the actual
 * push/pull logic) is delegated to session-store.ts, sync-client.ts, and sync-engine.ts
 * respectively; this class is just the glue plus in-memory status for the UI to poll.
 */
import type { SyncStatus } from '@shared/ipc'
import { login as backendLogin, logout as backendLogout, syncPull, syncPush } from '../backend/sync-client'
import { clearSession, loadSession, saveSession, type StoredSession } from '../backend/session-store'
import type { FlightdeckDb } from '../db/client'
import { runSync } from './sync-engine'

export class CloudSyncController {
  private session: StoredSession | null
  private syncing = false
  private lastSyncedAt: string | null = null
  private lastError: string | null = null

  constructor(
    private readonly db: FlightdeckDb,
    private readonly dbPath: string,
    private readonly userDataPath: string
  ) {
    this.session = loadSession(userDataPath)
  }

  getStatus(): SyncStatus {
    return {
      loggedIn: this.session !== null,
      email: this.session?.email ?? null,
      syncing: this.syncing,
      lastSyncedAt: this.lastSyncedAt,
      lastError: this.lastError
    }
  }

  async login(email: string, password: string): Promise<SyncStatus> {
    const { token, expiresAt } = await backendLogin(email, password)
    this.session = { email, token, expiresAt }
    saveSession(this.userDataPath, this.session)
    this.lastError = null
    return this.getStatus()
  }

  async logout(): Promise<SyncStatus> {
    if (this.session) {
      // Best-effort — logging out locally (clearing the stored token) must succeed
      // regardless of whether the server round-trip does; an unreachable backend
      // shouldn't leave the user stuck "logged in" on this device.
      await backendLogout(this.session.email, this.session.token).catch(() => {})
    }
    this.session = null
    clearSession(this.userDataPath)
    this.lastSyncedAt = null
    this.lastError = null
    return this.getStatus()
  }

  async syncNow(): Promise<SyncStatus> {
    if (!this.session) throw new Error('Not logged in')
    if (this.syncing) return this.getStatus() // already running — don't overlap two syncs
    this.syncing = true
    try {
      const result = await runSync(this.db, { syncPull, syncPush }, this.session, this.dbPath)
      this.lastSyncedAt = result.syncedAt
      this.lastError = null
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      // An expired/invalid session means the stored token is no longer usable — clear it
      // so the status correctly falls back to "log in again" rather than reporting
      // "logged in" while every future sync silently fails against the same dead token.
      if (this.lastError.includes('invalid or expired session')) {
        this.session = null
        clearSession(this.userDataPath)
      }
    } finally {
      this.syncing = false
    }
    return this.getStatus()
  }
}
