import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fileHostLinkStore } from './host-link-store'

const { isAsyncEncryptionAvailable, encryptStringAsync, decryptStringAsync } = vi.hoisted(() => ({
  isAsyncEncryptionAvailable: vi.fn(() => Promise.resolve(true)),
  // A fake, reversible "encryption": enough to prove the round trip and the unreadable-file path without a real OS keychain.
  encryptStringAsync: vi.fn((plain: string) => Promise.resolve(Buffer.from(plain, 'utf-8'))),
  decryptStringAsync: vi.fn((buf: Buffer) =>
    Promise.resolve({ result: buf.toString('utf-8'), shouldReEncrypt: false })
  )
}))

vi.mock('electron', () => ({
  safeStorage: { isAsyncEncryptionAvailable, encryptStringAsync, decryptStringAsync }
}))

const LINK = { address: '192.168.1.20:5051', token: 'device-token' }

describe('the host link store', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'winglog-host-link-'))
    isAsyncEncryptionAvailable.mockResolvedValue(true)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('has nothing stored until a sim PC is paired', async () => {
    expect(await fileHostLinkStore(dir).load()).toBeNull()
  })

  it('keeps the address and token encrypted in a file of its own, and gives them back', async () => {
    const store = fileHostLinkStore(dir)
    await store.save(LINK)
    expect(existsSync(join(dir, 'host-link.enc'))).toBe(true)
    expect(encryptStringAsync).toHaveBeenCalledWith(JSON.stringify(LINK))
    expect(await fileHostLinkStore(dir).load()).toEqual(LINK)
  })

  it('refuses to store a token it cannot encrypt, rather than writing it in the clear', async () => {
    isAsyncEncryptionAvailable.mockResolvedValue(false)
    await expect(fileHostLinkStore(dir).save(LINK)).rejects.toThrow()
    expect(existsSync(join(dir, 'host-link.enc'))).toBe(false)
  })

  it('reads a file this computer cannot decrypt, or that holds the wrong thing, as never paired', async () => {
    const store = fileHostLinkStore(dir)
    writeFileSync(join(dir, 'host-link.enc'), 'not a link')
    expect(await store.load()).toBeNull()
    writeFileSync(join(dir, 'host-link.enc'), JSON.stringify({ address: 5, token: 'x' }))
    expect(await store.load()).toBeNull()
    decryptStringAsync.mockRejectedValueOnce(new Error('keychain says no'))
    expect(await store.load()).toBeNull()
  })

  it('forgets the sim PC, and does not mind when there is none to forget', async () => {
    const store = fileHostLinkStore(dir)
    expect(() => store.clear()).not.toThrow()
    await store.save(LINK)
    store.clear()
    expect(existsSync(join(dir, 'host-link.enc'))).toBe(false)
    expect(await store.load()).toBeNull()
  })
})
