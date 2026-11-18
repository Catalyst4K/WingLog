/**
 * Where the sim PC keeps its TLS identity for the twin link (winglog-backend's docs/plans/security-audit-v2.md, step 22): the private key
 * and its certificate. The key is a credential, so the pair is encrypted at rest with Electron's `safeStorage` (DPAPI on Windows) in a file
 * of its own, `lan-identity.enc`, outside the database and so outside its backups and copies, as `host-link.enc` is. If the computer
 * cannot encrypt, there is no identity and nothing is written: the key is never kept in the clear.
 */
import { X509Certificate, createPrivateKey } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import { writeFileAtomically } from '../files/write-file-atomically'
import { logger } from '../logging/logger'
import { certificatePin, certificateToPem, makeHostCertificate } from './host-certificate'

/** The sim PC's key and certificate, as the TLS server takes them. */
export interface HostIdentity {
  /** The private key, PKCS#8 PEM. Only the TLS server is given it: never logged, sent or shown. */
  keyPem: string
  certPem: string
  /** The certificate's pin: public, shown to a twin to pair by. */
  pin: string
  /** Whether this identity was made just now (the first start, or the old file was lost or unreadable): every paired twin pinned another one. */
  isNew: boolean
}

/** The sim PC's identity, and how to get it. */
export interface HostIdentityStore {
  /**
   * @returns The identity kept, or a new one when there is none or it reads but cannot be decrypted or understood (`isNew`), or null when this
   *   computer cannot encrypt it or the file could not be read at all (a lock, a permission): no identity this time, the file left as it was, and
   *   the next start tries again.
   *   A new identity is not yet kept: the caller saves it once everything that depends on it being new has been done, so that a failure in
   *   between makes the next start do all of it again.
   */
  load: () => Promise<HostIdentity | null>
  /** Keeps an identity (the new one `load` made), whole or not at all. */
  save: (identity: HostIdentity) => Promise<void>
}

/** What `lan-identity.enc` holds, once decrypted. */
interface StoredIdentity {
  keyPem: string
  /** The certificate, DER, as base64. */
  certDer: string
}

/**
 * @param text The decrypted file.
 * @returns The identity it holds, or null when it is not a key with the certificate made for it.
 */
function readIdentity(text: string): HostIdentity | null {
  const stored = JSON.parse(text) as Partial<StoredIdentity>
  if (typeof stored.keyPem !== 'string' || typeof stored.certDer !== 'string') return null
  const certDer = Buffer.from(stored.certDer, 'base64')
  // A key that does not belong to the certificate would fail every handshake, so it counts as unreadable.
  if (!new X509Certificate(certDer).checkPrivateKey(createPrivateKey(stored.keyPem))) return null
  return {
    keyPem: stored.keyPem,
    certPem: certificateToPem(certDer),
    pin: certificatePin(certDer),
    isNew: false
  }
}

/** What loading the identity file found: the identity, that a new one is needed, or that the file could not be read this time. */
type StoredResult = HostIdentity | 'new' | 'unavailable'

/**
 * @param path The identity file.
 * @returns The identity in it; 'new' when there is no file, or it reads but will not decrypt, parse or match (one warning, which never
 *   contains the file or the reason, for the last of those); 'unavailable' when the file could not be read at all (one warning naming the
 *   error code), so that a lock held for a moment, by antivirus for instance, does not cost the sim PC its identity and unpair every twin.
 */
async function loadStored(path: string): Promise<StoredResult> {
  let encrypted: Buffer
  try {
    encrypted = readFileSync(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return 'new'
    logger.warn(
      `[lan] the sim PC identity file could not be read (${typeof code === 'string' ? code : 'unknown error'}); twins cannot connect this time, and it is tried again next start`
    )
    return 'unavailable'
  }
  try {
    const { result } = await safeStorage.decryptStringAsync(encrypted)
    const identity = readIdentity(result)
    if (identity) return identity
  } catch {
    // Deliberately not logged: a parse error's message can quote the decrypted text.
  }
  logger.warn(
    '[lan] the sim PC identity file could not be read; making a new one, which unpairs any other WingLog'
  )
  return 'new'
}

/**
 * @param userDataPath Electron's userData directory.
 * @returns The store, keeping `lan-identity.enc` there.
 */
export function fileHostIdentityStore(userDataPath: string): HostIdentityStore {
  const path = join(userDataPath, 'lan-identity.enc')
  return {
    async load() {
      if (!(await safeStorage.isAsyncEncryptionAvailable())) return null
      const stored = await loadStored(path)
      if (stored === 'unavailable') return null
      if (stored !== 'new') return stored
      const { keyPem, certPem, certDer } = makeHostCertificate()
      return { keyPem, certPem, pin: certificatePin(certDer), isNew: true }
    },
    async save(identity) {
      const file: StoredIdentity = {
        keyPem: identity.keyPem,
        certDer: new X509Certificate(identity.certPem).raw.toString('base64')
      }
      writeFileAtomically(path, await safeStorage.encryptStringAsync(JSON.stringify(file)))
    }
  }
}
