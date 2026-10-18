/** The file-naming rule of coding-standards.md §8: PascalCase for components and classes, kebab-case for the rest. */
import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Every .ts and .tsx file under a folder, vendored shadcn components and declaration files excluded. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'ui' && dir.endsWith('components') ? [] : sourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : []
  })
}

describe('source file names', () => {
  it('are PascalCase or kebab-case, never camelCase', () => {
    const allowed = /^([A-Z][A-Za-z0-9]*|[a-z0-9]+(-[a-z0-9]+)*)$/
    const bad = sourceFiles('src').filter((path) => {
      const name = basename(path)
      return !allowed.test(name.split('.')[0] ?? '')
    })
    expect(bad).toEqual([])
  })
})
