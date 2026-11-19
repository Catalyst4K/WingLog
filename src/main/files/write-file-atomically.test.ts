import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFileAtomically } from './write-file-atomically'

// The real fs with writeFileSync wrapped, so the write still happens and the call it was given can be checked.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) }
})

describe('writeFileAtomically', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'winglog-atomic-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('writes the file, replaces an earlier one, and leaves no temporary file', () => {
    const path = join(dir, 'secret.enc')
    writeFileAtomically(path, 'first')
    writeFileAtomically(path, Buffer.from('second'))
    expect(readFileSync(path, 'utf8')).toBe('second')
    expect(existsSync(`${path}.tmp`)).toBe(false)
  })

  it('flushes the temporary file to the disk before it is renamed over the file, so a power cut cannot leave an empty or partial one (review of 2026-11-18)', () => {
    const path = join(dir, 'secret.enc')
    writeFileAtomically(path, 'whole')
    expect(vi.mocked(writeFileSync)).toHaveBeenCalledWith(`${path}.tmp`, 'whole', { flush: true })
  })

  it('leaves what was there, and no temporary file, when the new one cannot be moved into place', () => {
    // A directory cannot be replaced by a file, so the rename fails after the temporary file was written.
    const path = join(dir, 'secret.enc')
    mkdirSync(path)
    writeFileSync(join(path, 'kept'), 'kept')
    expect(() => writeFileAtomically(path, 'new')).toThrow()
    expect(readFileSync(join(path, 'kept'), 'utf8')).toBe('kept')
    expect(existsSync(`${path}.tmp`)).toBe(false)
  })

  it('throws, and leaves the old file, when the temporary file cannot even be written', () => {
    const path = join(dir, 'secret.enc')
    writeFileSync(path, 'old')
    // A directory in the temporary file's place cannot be written as a file.
    mkdirSync(`${path}.tmp`)
    expect(() => writeFileAtomically(path, 'new')).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('old')
  })
})
