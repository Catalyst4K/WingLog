import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeFileAtomically } from './write-file-atomically'

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
