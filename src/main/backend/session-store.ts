/**
 * Persists the cloud-sync session token (winglog-backend/docs/plans/cloud-sync.md,
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
import { t } from '../i18n'

export interface StoredSession {
  email: string
  token: string
  expiresAt: string
}

/**
 * Where the encrypted session lives.
 *
 * @param userDataPath Electron's userData directory.
 * @returns The encrypted session file's path.
 */
function sessionFilePath(userDataPath: string): string {
  return join(userDataPath, 'cloud-session.enc')
}

/**
 * Stores the session, encrypted with the OS keychain.
 *
 * @param userDataPath Electron's userData directory.
 * @param session The signed-in account and its token.
 * @throws When the OS can't encrypt it (no keychain).
 */
export async function saveSession(userDataPath: string, session: StoredSession): Promise<void> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error(t('errors.credentialEncryptionUnavailable'))
  }
  writeFileSync(sessionFilePath(userDataPath), await safeStorage.encryptStringAsync(JSON.stringify(session)))
}

/** Null for "no session" — never set, cleared, or a file that's corrupted/undecryptable
 *  (e.g. moved to a machine whose OS keychain can't decrypt it). All three are the same
 *  case to a caller: there's no usable session, log in again.
 *
 * @param userDataPath Electron's userData directory.
 * @returns The session, or null.
 */
export async function loadSession(userDataPath: string): Promise<StoredSession | null> {
  const path = sessionFilePath(userDataPath)
  if (!existsSync(path)) return null
  try {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(readFileSync(path))
    const session = JSON.parse(result) as StoredSession
    // The OS key has rotated since this was written (never seen on Windows; possible with the Mac's keychain): write the file
    // again so it follows the current key. Failing to rewrite it must not lose a session that did read.
    if (shouldReEncrypt) await saveSession(userDataPath, session).catch(() => undefined)
    return session
  } catch {
    return null
  }
}

/**
 * Forgets the session (signing out). A no-op when there isn't one.
 *
 * @param userDataPath Electron's userData directory.
 */
export function clearSession(userDataPath: string): void {
  const path = sessionFilePath(userDataPath)
  if (existsSync(path)) unlinkSync(path)
}
