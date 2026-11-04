import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearSession, loadSession, saveSession, type StoredSession } from './session-store'

const { isAsyncEncryptionAvailable, encryptStringAsync, decryptStringAsync } = vi.hoisted(() => ({
  isAsyncEncryptionAvailable: vi.fn(() => Promise.resolve(true)),
  // A fake, reversible "encryption" — just enough to prove the round trip and the
  // corrupted-data path without pulling in a real OS keychain in a test.
  encryptStringAsync: vi.fn((plain: string) => Promise.resolve(Buffer.from(plain, 'utf-8'))),
  decryptStringAsync: vi.fn((buf: Buffer) =>
    Promise.resolve({ result: buf.toString('utf-8'), shouldReEncrypt: false })
  )
}))

vi.mock('electron', () => ({
  safeStorage: { isAsyncEncryptionAvailable, encryptStringAsync, decryptStringAsync }
}))

const SESSION: StoredSession = {
  email: 'callum.jones5@btinternet.com',
  token: 'test-token',
  expiresAt: '2026-09-07T00:00:00.000Z'
}

describe('session store', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'winglog-session-store-'))
    isAsyncEncryptionAvailable.mockResolvedValue(true)
    encryptStringAsync.mockClear()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns null when no session file exists', async () => {
    expect(await loadSession(dir)).toBeNull()
  })

  it('round-trips a saved session', async () => {
    await saveSession(dir, SESSION)
    expect(await loadSession(dir)).toEqual(SESSION)
  })

  it('rejects, writing nothing, when OS-level encryption is unavailable', async () => {
    isAsyncEncryptionAvailable.mockResolvedValue(false)
    await expect(saveSession(dir, SESSION)).rejects.toThrow(/encryption is not available/)
    expect(existsSync(join(dir, 'cloud-session.enc'))).toBe(false)
  })

  it('returns null for a corrupted/undecryptable session file', async () => {
    await saveSession(dir, SESSION)
    decryptStringAsync.mockRejectedValueOnce(new Error('bad ciphertext'))
    expect(await loadSession(dir)).toBeNull()
  })

  it('returns null when the decrypted text is not a session', async () => {
    await saveSession(dir, SESSION)
    decryptStringAsync.mockResolvedValueOnce({ result: 'not json', shouldReEncrypt: false })
    expect(await loadSession(dir)).toBeNull()
  })

  it('writes the file again when the OS key has rotated, and still returns the session', async () => {
    await saveSession(dir, SESSION)
    const file = join(dir, 'cloud-session.enc')
    writeFileSync(file, 'stale ciphertext')
    decryptStringAsync.mockResolvedValueOnce({ result: JSON.stringify(SESSION), shouldReEncrypt: true })

    expect(await loadSession(dir)).toEqual(SESSION)

    expect(readFileSync(file, 'utf-8')).toBe(JSON.stringify(SESSION))
  })

  it('still returns the session when rewriting it after a key rotation fails', async () => {
    await saveSession(dir, SESSION)
    decryptStringAsync.mockResolvedValueOnce({ result: JSON.stringify(SESSION), shouldReEncrypt: true })
    encryptStringAsync.mockRejectedValueOnce(new Error('keychain locked'))

    expect(await loadSession(dir)).toEqual(SESSION)
  })

  it('leaves the file alone when no re-encryption is needed', async () => {
    await saveSession(dir, SESSION)
    encryptStringAsync.mockClear()
    await loadSession(dir)
    expect(encryptStringAsync).not.toHaveBeenCalled()
  })

  it('clears a session file', async () => {
    await saveSession(dir, SESSION)
    clearSession(dir)
    expect(await loadSession(dir)).toBeNull()
  })

  it('is a no-op clearing a session that was never saved', () => {
    expect(() => clearSession(dir)).not.toThrow()
  })
})
