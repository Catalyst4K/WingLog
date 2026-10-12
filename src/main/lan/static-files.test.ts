import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { staticFilesFrom } from './static-files'

describe('staticFilesFrom', () => {
  const folders: string[] = []
  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
  })

  function pageFolder(): string {
    const folder = mkdtempSync(join(tmpdir(), 'winglog-lan-page-'))
    folders.push(folder)
    mkdirSync(join(folder, 'assets'))
    writeFileSync(join(folder, 'index.html'), '<h1>WingLog</h1>')
    writeFileSync(join(folder, 'assets', 'app.js'), 'console.log(1)')
    writeFileSync(join(folder, 'assets', 'app.css'), 'body{}')
    writeFileSync(join(folder, 'notes.txt'), 'not served')
    return folder
  }

  it('serves the built page at / and its assets at their paths, with the right types', () => {
    const lookup = staticFilesFrom(pageFolder())
    expect(lookup('/')).toEqual({ type: 'text/html; charset=utf-8', body: Buffer.from('<h1>WingLog</h1>') })
    expect(lookup('/index.html')?.type).toBe('text/html; charset=utf-8')
    expect(lookup('/assets/app.js')?.type).toBe('text/javascript; charset=utf-8')
    expect(lookup('/assets/app.css')?.type).toBe('text/css; charset=utf-8')
  })

  it('does not find a file of an unlisted type, a missing path, or anything outside the folder', () => {
    const lookup = staticFilesFrom(pageFolder())
    expect(lookup('/notes.txt')).toBeNull()
    expect(lookup('/missing.js')).toBeNull()
    expect(lookup('/../secret')).toBeNull()
    expect(lookup('/assets/../index.html/..')).toBeNull()
  })

  it('finds nothing when the page was never built', () => {
    expect(staticFilesFrom(join(tmpdir(), 'winglog-no-such-folder'))('/')).toBeNull()
  })
})
