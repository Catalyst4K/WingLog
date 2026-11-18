/**
 * Where the sim PC keeps its TLS identity for the twin link (winglog-backend's docs/plans/security-audit-v2.md, step 22): the private key
 * and its certificate. The key is a credential, so the pair is encrypted at rest with Electron's `safeStorage` (DPAPI on Windows) in a file
 * of its own, `lan-identity.enc`, outside the database and so outside its backups and copies, as `host-link.enc` is. If the computer
 * cannot encrypt, there is no identity and nothing is written: the key is never kept in the clear.
 */
import { X509Certificate, createPrivateKey } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
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
  /** @returns The identity (made and saved the first time), or null when this computer cannot encrypt it. */
  load: () => Promise<HostIdentity | null>
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

/**
 * @param path The identity file.
 * @returns The identity in it, or null when there is none or it cannot be read (one warning, which never contains the file or the reason).
 */
async function loadStored(path: string): Promise<HostIdentity | null> {
  if (!existsSync(path)) return null
  try {
    const { result } = await safeStorage.decryptStringAsync(readFileSync(path))
    const identity = readIdentity(result)
    if (identity) return identity
  } catch {
    // Deliberately not logged: a parse error's message can quote the decrypted text.
  }
  logger.warn(
    '[lan] the sim PC identity file could not be read; making a new one, which unpairs any other WingLog'
  )
  return null
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
      if (stored) return stored
      const { keyPem, certPem, certDer } = makeHostCertificate()
      const file: StoredIdentity = { keyPem, certDer: certDer.toString('base64') }
      writeFileAtomically(path, await safeStorage.encryptStringAsync(JSON.stringify(file)))
      return { keyPem, certPem, pin: certificatePin(certDer), isNew: true }
    }
  }
}
