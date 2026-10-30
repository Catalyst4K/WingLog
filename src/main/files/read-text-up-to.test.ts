import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readTextUpTo } from './read-text-up-to'

describe('readTextUpTo', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'winglog-read-text-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads a file that is within the limit, as text', () => {
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'cycle “2611”')
    expect(readTextUpTo(file, 1024)).toBe('cycle “2611”')
  })

  it('reads a file that is exactly the limit, and refuses one a byte over', () => {
    const file = join(dir, 'b.txt')
    writeFileSync(file, 'x'.repeat(100))
    expect(readTextUpTo(file, 100)).toBe('x'.repeat(100))
    expect(readTextUpTo(file, 99)).toBeNull()
  })

  it('reads an empty file as empty text', () => {
    const file = join(dir, 'empty.txt')
    writeFileSync(file, '')
    expect(readTextUpTo(file, 10)).toBe('')
  })

  it('is null for a file that is not there, and for a folder', () => {
    expect(readTextUpTo(join(dir, 'missing.txt'), 10)).toBeNull()
    expect(readTextUpTo(dir, 10)).toBeNull()
  })
})
