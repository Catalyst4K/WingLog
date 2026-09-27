import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readIniBuildsA350Maintenance } from './read-maintenance'

const FIXTURE = ['[apu]', 'apu_hours = 1565.109009', 'apu_oil = 10.463158', 'apu_start_cycles = 4.000000'].join('\n')

describe('readIniBuildsA350Maintenance', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'winglog-a350-test-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function maintenanceDir(): string {
    return join(root, 'inibuilds-aircraft-a350', 'work', 'Maintenance')
  }

  function writeDataFile(variant: string, filename: string, contents: string): string {
    const dir = join(maintenanceDir(), variant)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, filename)
    writeFileSync(path, contents, 'utf-8')
    return path
  }

  it('returns null when no folder is configured', async () => {
    expect(await readIniBuildsA350Maintenance(null, 'G-XWBS')).toBeNull()
  })

  it('returns null when the folder is set but the Maintenance directory does not exist', async () => {
    expect(await readIniBuildsA350Maintenance(root, 'G-XWBS')).toBeNull()
  })

  it('returns null when no filename in any variant folder contains the registration', async () => {
    writeDataFile('A350-900 (Default Cabin)', 'A359_INI.data', FIXTURE)
    expect(await readIniBuildsA350Maintenance(root, 'G-XWBS')).toBeNull()
  })

  it('reads and parses the file whose name contains the registration', async () => {
    writeDataFile('A350-1000 (Default Cabin)', 'INIBUILDS-A35K-BAW_G-XWBS.data', FIXTURE)
    const report = await readIniBuildsA350Maintenance(root, 'G-XWBS')
    expect(report).toEqual({
      addon: 'inibuildsA350',
      groups: [{ key: 'apu', fields: [{ key: 'apuHours', value: '1565.109009' }, { key: 'apuOilQuantity', value: '10.463158' }, { key: 'apuStartCycles', value: '4' }] }]
    })
  })

  it('matches case-insensitively', async () => {
    writeDataFile('A350-1000 (Default Cabin)', 'INIBUILDS-A35K-BAW_G-XWBS.data', FIXTURE)
    const report = await readIniBuildsA350Maintenance(root, 'g-xwbs')
    expect(report?.addon).toBe('inibuildsA350')
  })

  it('searches across multiple variant folders, not just the first', async () => {
    writeDataFile('A350-900 (Default Cabin)', 'A359_INI.data', FIXTURE)
    writeDataFile('A350-900 ULR', 'SINGAPORE AIRLINES 9V-SGG.data', FIXTURE)
    const report = await readIniBuildsA350Maintenance(root, '9V-SGG')
    expect(report?.addon).toBe('inibuildsA350')
  })

  it('never matches a "commons" pack file whose registration is not in the filename', async () => {
    // Confirmed real case (docs/wasm-maintenance-notes.md): a commons livery can represent a
    // real registration without spelling it out in the filename — this is the one case the
    // adapter deliberately does not handle, not a bug to work around.
    writeDataFile('A350-900 (Default Cabin)', 'CPA 900 COMMONS.data', FIXTURE)
    expect(await readIniBuildsA350Maintenance(root, 'B-LQA')).toBeNull()
  })

  it('picks the most recently modified file when more than one livery matches the registration', async () => {
    const older = writeDataFile('A350-900 (Default Cabin)', 'OLDER B-LRJ.data', '[apu]\napu_hours = 1.000000')
    const newer = writeDataFile('A350-900 (Default Cabin)', 'CATHAY PACIFIC B-LRJ.data', FIXTURE)
    const now = Date.now() / 1000
    utimesSync(older, now - 3600, now - 3600)
    utimesSync(newer, now, now)
    const report = await readIniBuildsA350Maintenance(root, 'B-LRJ')
    expect(report?.groups[0]?.fields[0]).toEqual({ key: 'apuHours', value: '1565.109009' })
  })

  it('returns null (never throws) for an unparsable file, degrading to no data', async () => {
    writeDataFile('A350-1000 (Default Cabin)', 'INIBUILDS-A35K-BAW_G-XWBS.data', '   \n\t\n   ')
    const report = await readIniBuildsA350Maintenance(root, 'G-XWBS')
    expect(report).toEqual({ addon: 'inibuildsA350', groups: [] })
  })

  it('skips an unreadable entry under Maintenance without failing the whole scan', async () => {
    // A stray file directly under Maintenance/ (not a variant subfolder) — readdir on it as
    // a directory fails, and that must be skipped, not thrown.
    mkdirSync(maintenanceDir(), { recursive: true })
    writeFileSync(join(maintenanceDir(), 'stray.txt'), 'not a directory entry', 'utf-8')
    writeDataFile('A350-1000 (Default Cabin)', 'INIBUILDS-A35K-BAW_G-XWBS.data', FIXTURE)
    const report = await readIniBuildsA350Maintenance(root, 'G-XWBS')
    expect(report?.addon).toBe('inibuildsA350')
  })

  it('returns null (never throws) if the matched "file" can no longer be read as one', async () => {
    // A directory whose name happens to end in .data and contain the registration — readFile
    // on it throws EISDIR after the listing already matched it (the same "gone/changed
    // between listing and reading" case GSX's own scan.ts guards against).
    mkdirSync(join(maintenanceDir(), 'A350-1000 (Default Cabin)', 'G-XWBS.data'), { recursive: true })
    const report = await readIniBuildsA350Maintenance(root, 'G-XWBS')
    expect(report).toBeNull()
  })
})
