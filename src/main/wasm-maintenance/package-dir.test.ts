import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolvePackageDir } from './package-dir'

describe('resolvePackageDir', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'winglog-package-dir-test-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('returns the package folder when it sits directly under folderPath', async () => {
    const dir = join(root, 'pmdg-aircraft-77w')
    mkdirSync(dir)
    expect(await resolvePackageDir(root, 'pmdg-aircraft-77w')).toBe(dir)
  })

  it('falls back to an MSFS2024 sibling when the package folder is not directly under folderPath', async () => {
    const dir = join(root, 'MSFS2024', 'pmdg-aircraft-77w')
    mkdirSync(dir, { recursive: true })
    expect(await resolvePackageDir(root, 'pmdg-aircraft-77w')).toBe(dir)
  })

  it('prefers the direct folder over an MSFS2024 sibling when both exist', async () => {
    const direct = join(root, 'pmdg-aircraft-77w')
    mkdirSync(direct)
    mkdirSync(join(root, 'MSFS2024', 'pmdg-aircraft-77w'), { recursive: true })
    expect(await resolvePackageDir(root, 'pmdg-aircraft-77w')).toBe(direct)
  })

  it('returns null when the package folder is found in neither location', async () => {
    expect(await resolvePackageDir(root, 'pmdg-aircraft-77w')).toBeNull()
  })

  it('returns null (never throws) when folderPath itself does not exist', async () => {
    expect(await resolvePackageDir(join(root, 'nonexistent'), 'pmdg-aircraft-77w')).toBeNull()
  })

  it('ignores a file that happens to share the package name, rather than treating it as the folder', async () => {
    writeFileSync(join(root, 'pmdg-aircraft-77w'), 'not a directory', 'utf-8')
    const nested = join(root, 'MSFS2024', 'pmdg-aircraft-77w')
    mkdirSync(nested, { recursive: true })
    expect(await resolvePackageDir(root, 'pmdg-aircraft-77w')).toBe(nested)
  })
})
