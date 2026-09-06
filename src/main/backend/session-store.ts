/**
 * Persists the cloud-sync session token (flightdeck-backend/docs/plans/cloud-sync.md,
 * "Client-side storage") — a credential, so it's encrypted at rest via Electron's
 * built-in safeStorage (OS keychain-backed, no new dependency) and kept in its own file,
 * deliberately outside the SQLite database: that DB is what Fleet/Logbook import-export
 * reads and writes wholesale, and a session token has no business ending up in an
 * exported fleet JSON someone hands to a friend. Only the token is stored here — the
 * password itself is never persisted anywhere outside the login form's submission.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'

export interface StoredSession {
  email: string
  token: string
  expiresAt: string
}

function sessionFilePath(userDataPath: string): string {
  return join(userDataPath, 'cloud-session.enc')
}

export function saveSession(userDataPath: string, session: StoredSession): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-level credential encryption is not available on this machine')
  }
  writeFileSync(sessionFilePath(userDataPath), safeStorage.encryptString(JSON.stringify(session)))
}

/** Null for "no session" — never set, cleared, or a file that's corrupted/undecryptable
 *  (e.g. moved to a machine whose OS keychain can't decrypt it). All three are the same
 *  case to a caller: there's no usable session, log in again. */
export function loadSession(userDataPath: string): StoredSession | null {
  const path = sessionFilePath(userDataPath)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(safeStorage.decryptString(readFileSync(path))) as StoredSession
  } catch {
    return null
  }
}

export function clearSession(userDataPath: string): void {
  const path = sessionFilePath(userDataPath)
  if (existsSync(path)) unlinkSync(path)
}
