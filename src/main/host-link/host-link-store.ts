/**
 * Where a client keeps the sim PC it is paired with: its address and the device token the host gave it. The token is a credential, so
 * the pair is encrypted at rest with Electron's `safeStorage` (the OS keychain) in a file of its own, outside the database, as the cloud
 * sync session is (backend/session-store.ts).
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import { t } from '../i18n'

export interface StoredHostLink {
  /** The host's `host:port`. */
  address: string
  /** The device token the host gave on pairing. */
  token: string
}

/** The host link a client has stored, and how to keep it. */
export interface HostLinkStore {
  load: () => Promise<StoredHostLink | null>
  save: (link: StoredHostLink) => Promise<void>
  clear: () => void
}

/**
 * @param userDataPath Electron's userData directory.
 * @returns The store, writing `host-link.enc` there.
 */
export function fileHostLinkStore(userDataPath: string): HostLinkStore {
  const path = join(userDataPath, 'host-link.enc')
  return {
    async load() {
      if (!existsSync(path)) return null
      try {
        const { result } = await safeStorage.decryptStringAsync(readFileSync(path))
        const link = JSON.parse(result) as Partial<StoredHostLink>
        return typeof link.address === 'string' && typeof link.token === 'string'
          ? { address: link.address, token: link.token }
          : null
      } catch {
        // Unreadable (moved to a machine whose keychain cannot decrypt it): the same as never paired.
        return null
      }
    },
    async save(link) {
      if (!(await safeStorage.isAsyncEncryptionAvailable())) {
        throw new Error(t('errors.credentialEncryptionUnavailable'))
      }
      writeFileSync(path, await safeStorage.encryptStringAsync(JSON.stringify(link)))
    },
    clear() {
      if (existsSync(path)) unlinkSync(path)
    }
  }
}
