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

  it('finds the package folder under an MSFS2024 sibling when it is not directly under folderPath', async () => {
    // Confirmed real case, flightdeck-backend's docs/wasm-maintenance-notes.md: a Store
    // install nests every add-on's package folder under WASM/MSFS2024/, not directly under
    // the WASM folder a user would naturally pick in the folder browser.
    const dir = join(root, 'MSFS2024', 'pmdg-aircraft-77w', 'work', 'Aircraft')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'G-XWBS.hours'), FIXTURE, 'utf-8')

    const report = await readPmdg777Maintenance(root, 'G-XWBS')
    expect(report?.addon).toBe('pmdg777')
  })

  it('prefers the package folder directly under folderPath over an MSFS2024 sibling when both exist', async () => {
    writeHoursFile('G-XWBS', FIXTURE)
    const nestedDir = join(root, 'MSFS2024', 'pmdg-aircraft-77w', 'work', 'Aircraft')
    mkdirSync(nestedDir, { recursive: true })
    writeFileSync(join(nestedDir, 'G-XWBS.hours'), '[Engines]\nOilQ_Last.0=1\n', 'utf-8')

    const report = await readPmdg777Maintenance(root, 'G-XWBS')
    expect(report?.groups[0]?.fields[0]).toEqual({ key: 'oilQuantity', index: 1, value: '1854' })
  })
})
