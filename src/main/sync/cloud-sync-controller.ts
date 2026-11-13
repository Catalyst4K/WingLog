/**
 * Owns cloud-sync's runtime state (docs/plans/cloud-sync.md) — the logged-in session, and
 * whether a sync is in progress — and is the one thing main/index.ts wires the IPC
 * channels to. Everything else (session persistence, the wire protocol, the actual
 * push/pull logic) is delegated to session-store.ts, sync-client.ts, and sync-engine.ts
 * respectively; this class is just the glue plus in-memory status for the UI to poll.
 */
import type { SyncStatus } from '@shared/ipc'
import { t } from '../i18n'
import {
  login as backendLogin,
  logout as backendLogout,
  deleteAccount as backendDeleteAccount,
  forgotPassword as backendForgotPassword,
  resetPassword as backendResetPassword,
  provision as backendProvision,
  CLOUD_SYNC_TABLES,
  syncPullPage,
  syncPush
} from '../backend/sync-client'
import { isSessionRefused } from '../backend/backend-error'
import { clearSession, saveSession, type StoredSession } from '../backend/session-store'
import { join } from 'node:path'
import { backupBeforeFirstSync } from '../db/backup'
import {
  deleteSetting,
  getLastSyncCompletedAt,
  getSetting,
  setLastSyncCompletedAt,
  setSetting
} from '../db/settings-repo'
import type { WingLogDb } from '../db/client'
import { resetPeer, runCursorSync } from './cursor-sync'

/** Whose cursors and whose rows' origin these are: the cloud account, as against a twin or the sim PC. */
const CLOUD_PEER = 'cloud'

/**
 * @param email The account's address.
 * @returns The setting that says this computer has already made its first sync with the account (and where the backup before it went).
 */
function firstSyncBackupKey(email: string): string {
  return `firstSyncBackup:${email}`
}

/**
 * Cloud sync for the app: the signed-in session, its status, and running a sync.
 */
export class CloudSyncController {
  private session: StoredSession | null
  private syncing = false
  private lastSyncedAt: string | null
  private lastError: string | null = null

  constructor(
    private readonly db: WingLogDb,
    private readonly dbPath: string,
    private readonly userDataPath: string,
    // Read before startup (session-store.ts reads it asynchronously); null when signed out.
    session: StoredSession | null
  ) {
    this.session = session
    this.lastSyncedAt = getLastSyncCompletedAt(db)
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
    const session = { email, token, expiresAt }
    // Saved first: if the OS cannot encrypt it, the login fails instead of leaving a session that is lost on restart.
    await saveSession(this.userDataPath, session)
    this.session = session
    this.lastError = null
    return this.getStatus()
  }

  /**
   * Provision then log in — see sync-client.ts's provision() for the invite-code gate.
   *
   * @param email The account email.
   * @param password The password.
   * @param inviteCode The invite code.
   * @returns The status after logging in.
   */
  async signup(email: string, password: string, inviteCode: string): Promise<SyncStatus> {
    await backendProvision(email, password, inviteCode)
    return this.login(email, password)
  }

  async logout(): Promise<SyncStatus> {
    if (this.session) {
      // Best-effort — logging out locally (clearing the stored token) must succeed
      // regardless of whether the server round-trip does; an unreachable backend
      // shouldn't leave the user stuck "logged in" on this device.
      await backendLogout(this.session.email, this.session.token).catch(() => {})
    }
    return this.forgetSession()
  }

  /**
   * Asks for a password reset code to be emailed. Needs no session: the person has lost the password.
   *
   * @param email The account's address.
   */
  async forgotPassword(email: string): Promise<void> {
    await backendForgotPassword(email)
  }

  /**
   * Sets a new password with the emailed code. The service signs every device out, so this computer's saved session is dropped too if it
   * was for that account, and the next sync is a fresh sign-in.
   *
   * @param email The account's address.
   * @param code The code from the email.
   * @param password The new password.
   * @returns The status afterwards.
   * @throws When the code is refused.
   */
  async resetPassword(email: string, code: string, password: string): Promise<SyncStatus> {
    await backendResetPassword(email, code, password)
    if (this.session?.email.trim().toLowerCase() === email.trim().toLowerCase()) return this.forgetSession()
    return this.getStatus()
  }

  /**
   * Deletes the cloud account and everything stored in it (the right to erasure; winglog-backend's docs/plans/cloud-sync-v2.md, section 4).
   * The data on this computer stays. The password is asked for again so a signed-in session left open cannot delete the account.
   *
   * @param password The account's password.
   * @returns The signed-out status.
   * @throws When not signed in, or the backend refuses (a wrong password): then nothing is deleted and the session stays.
   */
  async deleteAccount(password: string): Promise<SyncStatus> {
    if (!this.session) throw new Error(t('errors.notLoggedIn'))
    await backendDeleteAccount(this.session.email, password)
    // A later account on this computer is sent everything, not only what changed since this one's last sync.
    resetPeer(this.db, CLOUD_PEER)
    return this.forgetSession()
  }

  /**
   * Signs this computer out. The account's first-sync marker goes too, so the next sign-in, to whatever account is then under this address
   * (it may have been deleted and made again meanwhile), is a first sync: a backup, then everything sent and fetched (review of L11).
   *
   * @returns The signed-out status, after the session and the last-synced time are forgotten here.
   */
  private forgetSession(): SyncStatus {
    if (this.session) deleteSetting(this.db, firstSyncBackupKey(this.session.email))
    this.session = null
    clearSession(this.userDataPath)
    this.lastSyncedAt = null
    setLastSyncCompletedAt(this.db, '')
    this.lastError = null
    return this.getStatus()
  }

  /**
   * Runs a sync cycle, pull then push. Does nothing extra when a sync is already running.
   *
   * @returns The sync status afterwards.
   */
  async syncNow(): Promise<SyncStatus> {
    if (!this.session) throw new Error(t('errors.notLoggedIn'))
    if (this.syncing) return this.getStatus() // already running — don't overlap two syncs
    this.syncing = true
    try {
      // A device's first sync with an account can overwrite local rows with newer ones from another
      // device, so snapshot the database first. If the snapshot fails, no sync runs.
      const backupKey = firstSyncBackupKey(this.session.email)
      if (getSetting(this.db, backupKey) === undefined) {
        const backup = backupBeforeFirstSync(this.dbPath, join(this.userDataPath, 'backups'))
        // The cursors belong to the account the device last synced with. A new account starts empty, so with the old cursors it would be sent only
        // what changed since, and never the rest. The first sync with an account sends and fetches everything.
        resetPeer(this.db, CLOUD_PEER)
        setSetting(this.db, backupKey, backup ?? 'no database file')
      }
      const result = await runCursorSync(
        this.db,
        { syncPullPage, syncPush },
        this.session,
        this.dbPath,
        CLOUD_PEER,
        CLOUD_SYNC_TABLES
      )
      this.lastSyncedAt = result.syncedAt
      setLastSyncCompletedAt(this.db, result.syncedAt)
      this.lastError = null
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      // A 401 means the stored token is no longer usable (judged by the status, not the words of the answer) — clear it
      // so the status correctly falls back to "log in again" rather than reporting
      // "logged in" while every future sync silently fails against the same dead token.
      if (isSessionRefused(err)) {
        // The account may have been deleted and made again under this address: the next sign-in is a first sync again (a backup, then
        // everything sent and fetched), not a continuation with cursors that belong to the account that is gone (audit L11).
        if (this.session) deleteSetting(this.db, firstSyncBackupKey(this.session.email))
        this.session = null
        clearSession(this.userDataPath)
      }
    } finally {
      this.syncing = false
    }
    return this.getStatus()
  }
}
