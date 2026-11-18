import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logger } from '../logging/logger'
import { certificatePin, makeHostCertificate } from './host-certificate'
import { fileHostIdentityStore } from './host-identity-store'

const { isAsyncEncryptionAvailable, encryptStringAsync, decryptStringAsync } = vi.hoisted(() => ({
  isAsyncEncryptionAvailable: vi.fn(() => Promise.resolve(true)),
  // A fake, reversible "encryption" (base64 is not readable as a PEM): enough to prove the file is not the key in clear.
  encryptStringAsync: vi.fn((plain: string) =>
    Promise.resolve(Buffer.from(Buffer.from(plain, 'utf-8').toString('base64')))
  ),
  decryptStringAsync: vi.fn((buf: Buffer) =>
    Promise.resolve({
      result: Buffer.from(buf.toString(), 'base64').toString('utf-8'),
      shouldReEncrypt: false
    })
  )
}))

vi.mock('electron', () => ({
  safeStorage: { isAsyncEncryptionAvailable, encryptStringAsync, decryptStringAsync }
}))
vi.mock('../logging/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }))

describe('the host identity store', () => {
  let dir: string
  const file = () => join(dir, 'lan-identity.enc')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'winglog-lan-identity-'))
    isAsyncEncryptionAvailable.mockResolvedValue(true)
    vi.mocked(logger.warn).mockClear()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('makes an identity the first time and keeps it: the next load is the same one, no longer new', async () => {
    const first = await fileHostIdentityStore(dir).load()
    expect(first?.isNew).toBe(true)
    expect(first?.pin).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(first?.certPem).toContain('BEGIN CERTIFICATE')
    const second = await fileHostIdentityStore(dir).load()
    expect(second).toEqual({ ...first, isNew: false })
  })

  it('writes the identity encrypted, never the key in the clear', async () => {
    const identity = await fileHostIdentityStore(dir).load()
    expect(encryptStringAsync).toHaveBeenCalled()
    const onDisk = readFileSync(file()).toString('latin1')
    expect(onDisk).not.toContain('PRIVATE KEY')
    expect(onDisk).not.toContain(identity?.keyPem.split('\n')[1] ?? 'unreachable')
  })

  it('replaces a file it cannot decrypt, or that holds the wrong thing, with a new identity and one warning', async () => {
    const store = fileHostIdentityStore(dir)
    const first = await store.load()
    for (const bad of [
      () => writeFileSync(file(), 'not an identity'),
      () =>
        writeFileSync(file(), Buffer.from(JSON.stringify({ keyPem: 5, certDer: 'x' })).toString('base64')),
      () => decryptStringAsync.mockRejectedValueOnce(new Error('keychain says no'))
    ]) {
      bad()
      vi.mocked(logger.warn).mockClear()
      const next = await store.load()
      expect(next?.isNew).toBe(true)
      expect(next?.pin).not.toBe(first?.pin)
      expect(logger.warn).toHaveBeenCalledTimes(1)
    }
  })

  it('leaves the file it had when a new identity cannot be written whole', async () => {
    writeFileSync(file(), 'not an identity')
    // A directory in the temporary file's place makes the write fail before anything is moved into place.
    mkdirSync(`${file()}.tmp`)
    await expect(fileHostIdentityStore(dir).load()).rejects.toThrow()
    expect(readFileSync(file(), 'utf8')).toBe('not an identity')
  })

  it('treats a key that does not belong to the certificate as unreadable', async () => {
    const one = makeHostCertificate()
    const other = makeHostCertificate()
    const mismatched = JSON.stringify({ keyPem: other.keyPem, certDer: one.certDer.toString('base64') })
    writeFileSync(file(), Buffer.from(mismatched).toString('base64'))
    const identity = await fileHostIdentityStore(dir).load()
    expect(identity?.isNew).toBe(true)
    expect(identity?.pin).not.toBe(certificatePin(one.certDer))
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('never puts the file, the key or the parse error in the warning', async () => {
    writeFileSync(file(), Buffer.from('secret-key-material {not json').toString('base64'))
    await fileHostIdentityStore(dir).load()
    const logged = JSON.stringify(vi.mocked(logger.warn).mock.calls)
    expect(logged).not.toContain('secret-key-material')
    expect(logged).not.toContain('PRIVATE')
    expect(logged).not.toContain('JSON')
  })

  it('gives nothing and writes nothing when this computer cannot encrypt', async () => {
    isAsyncEncryptionAvailable.mockResolvedValue(false)
    expect(await fileHostIdentityStore(dir).load()).toBeNull()
    expect(existsSync(file())).toBe(false)
  })
})
