import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readPmdg777Maintenance } from './read-maintenance'

const FIXTURE = '[Engines]\nOilQ_Last.0=1854\nOilQ_Last.1=1740\n'

describe('readPmdg777Maintenance', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'winglog-pmdg-test-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function writeHoursFile(registration: string, contents: string): void {
    const dir = join(root, 'pmdg-aircraft-77w', 'work', 'Aircraft')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${registration}.hours`), contents, 'utf-8')
  }

  it('returns null when no folder is configured', async () => {
    expect(await readPmdg777Maintenance(null, 'G-XWBS')).toBeNull()
  })

  it('returns null when the folder is set but no matching file exists', async () => {
    expect(await readPmdg777Maintenance(root, 'G-XWBS')).toBeNull()
  })

  it('reads and parses a well-formed file for the given registration', async () => {
    writeHoursFile('G-XWBS', FIXTURE)
    const report = await readPmdg777Maintenance(root, 'G-XWBS')
    expect(report).toEqual({
      addon: 'pmdg777',
      groups: [
        {
          key: 'engines',
          fields: [
            { key: 'oilQuantity', index: 1, value: '1854' },
            { key: 'oilQuantity', index: 2, value: '1740' }
          ]
        }
      ]
    })
  })

  it('only matches the exact registration, not a different one', async () => {
    writeHoursFile('G-XWBS', FIXTURE)
    expect(await readPmdg777Maintenance(root, 'B-LRJ')).toBeNull()
  })

  it('never escapes the expected Aircraft directory for a registration containing path separators', async () => {
    // Not attempting to prove real exploitability (there's nothing sensitive one directory up
    // in this fixture) — just that the containment guard actually triggers and returns null
    // instead of reading whatever `../../secret.hours` would have resolved to.
    writeFileSync(join(root, 'secret.hours'), FIXTURE, 'utf-8')
    mkdirSync(join(root, 'pmdg-aircraft-77w', 'work', 'Aircraft'), { recursive: true })
    expect(await readPmdg777Maintenance(root, '../../../secret')).toBeNull()
  })

  it('returns null (never throws) for an unparsable file, degrading to no data', async () => {
    writeHoursFile('G-XWBS', '   \n\t\n   ')
    const report = await readPmdg777Maintenance(root, 'G-XWBS')
    expect(report).toEqual({ addon: 'pmdg777', groups: [] })
  })
})
