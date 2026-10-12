/**
 * The cross-platform rule that lint can't state (winglog-backend docs/plans/cross-platform.md): outside src/main/platform/, nothing
 * reads the operating system's own environment (`APPDATA`, `LOCALAPPDATA`, `USERPROFILE`, `HOME`) or names a drive-letter or backslash
 * path, since each would work on one OS and quietly break on another. `process.platform` itself is a lint error (eslint.config.mjs).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(__dirname, '..', '..')
const OS_ENVIRONMENT =
  /process\.env\.(?:APPDATA|LOCALAPPDATA|USERPROFILE|HOME|XDG_[A-Z_]+)\b|process\.env\[\s*['"](?:APPDATA|LOCALAPPDATA|USERPROFILE|HOME)['"]\s*\]/

/** Every non-test TypeScript source file under src/, outside the platform module itself. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory())
      return relative(SRC, path).split(sep).join('/') === 'main/platform' ? [] : sourceFiles(path)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')
      ? [path]
      : []
  })
}

/** Lines of code: comments and blank lines left out. */
function codeLines(file: string): { line: number; text: string }[] {
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((text, i) => ({ line: i + 1, text }))
    .filter(({ text }) => text.trim() !== '' && !/^\s*(\/\/|\*|\/\*)/.test(text))
}

describe('the platform module is the only place that asks the operating system', () => {
  const files = sourceFiles(SRC)

  it('finds the source it should be checking', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it("reads no OS environment variable outside src/main/platform/ (use the platform module's paths)", () => {
    const found = files.flatMap((file) =>
      codeLines(file)
        .filter(({ text }) => OS_ENVIRONMENT.test(text))
        .map(({ line }) => `${relative(SRC, file)}:${line}`)
    )
    expect(found).toEqual([])
  })

  it('writes no drive-letter path literal in app code', () => {
    const found = files.flatMap((file) =>
      codeLines(file)
        .filter(({ text }) => /['"`][A-Za-z]:\\\\/.test(text))
        .map(({ line }) => `${relative(SRC, file)}:${line}`)
    )
    expect(found).toEqual([])
  })
})
