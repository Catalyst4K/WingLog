import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearSession, loadSession, saveSession, type StoredSession } from './session-store'

const { isEncryptionAvailable, encryptString, decryptString } = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  // A fake, reversible "encryption" — just enough to prove the round trip and the
  // corrupted-data path without pulling in a real OS keychain in a test.
  encryptString: vi.fn((plain: string) => Buffer.from(plain, 'utf-8')),
  decryptString: vi.fn((buf: Buffer) => buf.toString('utf-8'))
}))

vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable, encryptString, decryptString }
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
    isEncryptionAvailable.mockReturnValue(true)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns null when no session file exists', () => {
    expect(loadSession(dir)).toBeNull()
  })

  it('round-trips a saved session', () => {
    saveSession(dir, SESSION)
    expect(loadSession(dir)).toEqual(SESSION)
  })

  it('throws when OS-level encryption is unavailable', () => {
    isEncryptionAvailable.mockReturnValue(false)
    expect(() => saveSession(dir, SESSION)).toThrow(/encryption is not available/)
  })

  it('returns null for a corrupted/undecryptable session file', () => {
    saveSession(dir, SESSION)
    decryptString.mockImplementationOnce(() => {
      throw new Error('bad ciphertext')
    })
    expect(loadSession(dir)).toBeNull()
  })

  it('clears a session file', () => {
    saveSession(dir, SESSION)
    clearSession(dir)
    expect(loadSession(dir)).toBeNull()
  })

  it('is a no-op clearing a session that was never saved', () => {
    expect(() => clearSession(dir)).not.toThrow()
  })
})
