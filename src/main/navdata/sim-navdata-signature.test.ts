import { join as nodeJoin, win32 } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createNavdataSignatureReader,
  navdataStatusOf,
  parseNavigraphCycle,
  parsePackagesPath,
  readNavdataSignature,
  signatureFilesFor,
  staleBeforeMs,
  type NavdataSignature,
  type SignatureFiles
} from './sim-navdata-signature'

/** A real `cycle.json` as the Navigraph Hub wrote it on 2026-10-29. */
const CYCLE_2611 = JSON.stringify({
  cycle: '2611',
  revision: '1',
  name: 'MSFS2024',
  build: '1.0.3',
  provider: 'JEPPESEN',
  manufacturerLong: 'NAVIGRAPH',
  manufacturerShort: 'NG',
  format: 'custom',
  validityPeriod: '2026-10-29/2026-11-25',
  createdOn: '2026-10-28 15:40:20 UTC'
})
const INSTALLED_MS = Date.parse('2026-10-29T15:49:31.878Z')

// Windows paths on every system: MSFS 2024 is Windows-only, and the module reads them as such.
const join = win32.join
const LOCAL = join('C:', 'Users', 'pilot', 'AppData', 'Local')
const ROAMING = join('C:', 'Users', 'pilot', 'AppData', 'Roaming')
const STORE_CFG = join(LOCAL, 'Packages', 'Microsoft.Limitless_8wekyb3d8bbwe', 'LocalCache', 'UserCfg.opt')
const STEAM_CFG = join(ROAMING, 'Microsoft Flight Simulator 2024', 'UserCfg.opt')
const PACKAGES = join(LOCAL, 'Packages', 'Microsoft.Limitless_8wekyb3d8bbwe', 'LocalCache', 'Packages')
const cycleFileIn = (packages: string): string =>
  join(packages, 'Community', 'navigraph-nav-base', 'ContentInfo', 'navigraph-navdata', 'cycle.json')

/** A disk of named files: the text of each, and when it was written. */
function disk(files: Record<string, string>, modified = INSTALLED_MS): SignatureFiles {
  return {
    userCfgPaths: [STORE_CFG, STEAM_CFG],
    readText: (path, maxBytes) => {
      const text = files[path]
      return text === undefined || text.length > maxBytes ? null : text
    },
    modifiedMs: (path) => (files[path] === undefined ? null : modified)
  }
}

const cfgWith = (packages: string): string =>
  `{\r\nGraphics}\r\nInstalledPackagesPath "${packages}"\r\nUserName x\r\n`

describe('parsePackagesPath', () => {
  it('reads the quoted path out of a UserCfg.opt', () => {
    expect(parsePackagesPath(cfgWith(PACKAGES))).toBe(PACKAGES)
  })

  it.each([
    ['no such line', 'UserName x\r\n'],
    ['an empty path', 'InstalledPackagesPath ""\r\n'],
    ['a relative path', 'InstalledPackagesPath "Packages"\r\n'],
    ['an unquoted path', `InstalledPackagesPath ${PACKAGES}\r\n`]
  ])('is null for %s', (_label, text) => {
    expect(parsePackagesPath(text)).toBeNull()
  })
})

describe('parseNavigraphCycle', () => {
  it('reads the cycle, revision and last valid day, and when it was installed', () => {
    expect(parseNavigraphCycle(CYCLE_2611, INSTALLED_MS)).toEqual({
      source: 'navigraph',
      cycle: '2611',
      revision: '1',
      validTo: '2026-11-25',
      installedAtMs: INSTALLED_MS
    })
  })

  it('takes revision 1 and no end date when the file leaves them out or gives odd ones', () => {
    expect(
      parseNavigraphCycle(JSON.stringify({ cycle: '2612', revision: '<b>x</b>', validityPeriod: 'soon' }), 5)
    ).toEqual({ source: 'navigraph', cycle: '2612', revision: '1', validTo: null, installedAtMs: 5 })
  })

  it.each([
    ['not JSON', 'cycle 2611'],
    ['JSON that is not an object', '[2611]'],
    ['null', 'null'],
    ['no cycle', '{"revision":"1"}'],
    ['a cycle that is not four digits', '{"cycle":"26-11"}'],
    ['a cycle that is not text', '{"cycle":2611}']
  ])('is null for %s', (_label, text) => {
    expect(parseNavigraphCycle(text, INSTALLED_MS)).toBeNull()
  })

  it('is null when the install time is not a time', () => {
    expect(parseNavigraphCycle(CYCLE_2611, Number.NaN)).toBeNull()
  })
})

describe('a path from the root without a drive (the end-to-end tests’ fake install on Linux)', () => {
  const packages = '/tmp/fake-msfs/Packages'

  it('is read as a packages path, and the cycle file is found under it with slashes', () => {
    expect(parsePackagesPath(cfgWith(packages))).toBe(packages)
    const cycleFile = `${packages}/Community/navigraph-nav-base/ContentInfo/navigraph-navdata/cycle.json`
    const files = disk({ [STORE_CFG]: cfgWith(packages), [cycleFile]: CYCLE_2611 })
    expect(readNavdataSignature(files)).toMatchObject({ source: 'navigraph', cycle: '2611' })
  })
})

describe('readNavdataSignature', () => {
  it('finds Navigraph through the Store build’s UserCfg.opt', () => {
    const files = disk({ [STORE_CFG]: cfgWith(PACKAGES), [cycleFileIn(PACKAGES)]: CYCLE_2611 })
    expect(readNavdataSignature(files)).toMatchObject({
      source: 'navigraph',
      cycle: '2611',
      installedAtMs: INSTALLED_MS
    })
  })

  it('finds it through Steam’s UserCfg.opt when the Store build has none', () => {
    const packages = join('D:', 'MSFS', 'Packages')
    const files = disk({ [STEAM_CFG]: cfgWith(packages), [cycleFileIn(packages)]: CYCLE_2611 })
    expect(readNavdataSignature(files)).toMatchObject({ source: 'navigraph', cycle: '2611' })
  })

  it('is the sim’s own data when Navigraph is not installed, or its file is odd, or nothing can be read', () => {
    expect(readNavdataSignature(disk({ [STORE_CFG]: cfgWith(PACKAGES) }))).toEqual({ source: 'default' })
    expect(
      readNavdataSignature(disk({ [STORE_CFG]: cfgWith(PACKAGES), [cycleFileIn(PACKAGES)]: 'not json' }))
    ).toEqual({ source: 'default' })
    expect(readNavdataSignature(disk({}))).toEqual({ source: 'default' })
    expect(readNavdataSignature({ ...disk({}), userCfgPaths: [] })).toEqual({
      source: 'default'
    })
  })

  it('reads nothing longer than the limits: a huge cycle file is not Navigraph’s', () => {
    const huge = JSON.stringify({ cycle: '2611', padding: 'x'.repeat(10_000) })
    expect(
      readNavdataSignature(disk({ [STORE_CFG]: cfgWith(PACKAGES), [cycleFileIn(PACKAGES)]: huge }))
    ).toEqual({ source: 'default' })
  })
})

describe('createNavdataSignatureReader', () => {
  it('reads the disk once for a burst of calls, and again after half a minute', () => {
    const files = disk({ [STORE_CFG]: cfgWith(PACKAGES), [cycleFileIn(PACKAGES)]: CYCLE_2611 })
    const readText = vi.spyOn(files, 'readText')
    let at = Date.parse('2026-10-29T16:00:00Z')
    const read = createNavdataSignatureReader(files, () => new Date(at))
    read()
    read()
    expect(readText).toHaveBeenCalledTimes(2)
    at += 31_000
    read()
    expect(readText).toHaveBeenCalledTimes(4)
  })
})

describe('signatureFilesFor', () => {
  const folder = nodeJoin('C:', 'temp', 'fake-msfs')

  it('points an unpackaged end-to-end run at a UserCfg.opt of its own, so it never reads this machine’s install', () => {
    const files = signatureFilesFor(false, { WINGLOG_E2E_MSFS_DIR: folder })
    expect(files.userCfgPaths).toEqual([nodeJoin(folder, 'UserCfg.opt')])
  })

  it('ignores the override in an installed build', () => {
    const files = signatureFilesFor(true, { WINGLOG_E2E_MSFS_DIR: folder })
    expect(files.userCfgPaths).not.toContain(nodeJoin(folder, 'UserCfg.opt'))
  })

  it('reads the real disk, where a file that is not there is simply not there', () => {
    const files = signatureFilesFor(false, {})
    const missing = nodeJoin(folder, 'nothing-here.json')
    expect(files.readText(missing, 100)).toBeNull()
    expect(files.modifiedMs(missing)).toBeNull()
  })

  it('reads a real file, and refuses one over the limit', () => {
    const files = signatureFilesFor(false, {})
    const own = nodeJoin(process.cwd(), 'package.json')
    expect(files.readText(own, 10_000_000)).toContain('"name"')
    expect(files.readText(own, 10)).toBeNull()
    expect(files.modifiedMs(own)).toBeGreaterThan(0)
  })
})

describe('staleBeforeMs', () => {
  const calendarStart = Date.parse('2026-10-29T00:00:00Z')

  it('is the install time for Navigraph: the day a cycle starts must not mark the old data fresh before it is installed', () => {
    const navigraph = parseNavigraphCycle(CYCLE_2611, INSTALLED_MS) as NavdataSignature
    expect(staleBeforeMs(navigraph, calendarStart)).toBe(INSTALLED_MS)
    // A fetch at 10:00 UTC today (the old cycle's data) is before the install, so it is stale; one at 16:00 is not.
    expect(Date.parse('2026-10-29T10:00:00Z') < staleBeforeMs(navigraph, calendarStart)).toBe(true)
    expect(Date.parse('2026-10-29T16:00:00Z') < staleBeforeMs(navigraph, calendarStart)).toBe(false)
  })

  it('is the calendar cycle’s start for the sim’s own data', () => {
    expect(staleBeforeMs({ source: 'default' }, calendarStart)).toBe(calendarStart)
  })
})

describe('navdataStatusOf', () => {
  const on = (iso: string): Date => new Date(`${iso}T12:00:00Z`)
  const navigraph = (cycle: string): NavdataSignature => ({
    source: 'navigraph',
    cycle,
    revision: '2',
    validTo: '2026-11-25',
    installedAtMs: INSTALLED_MS
  })

  it('is current when the package is the calendar’s cycle, and says which', () => {
    expect(navdataStatusOf(navigraph('2611'), on('2026-11-02'))).toEqual({
      source: 'navigraph',
      cycle: '2611',
      revision: '2',
      validTo: '2026-11-25',
      calendarCycle: '2611',
      state: 'current'
    })
  })

  it('is behind when the package is an older cycle: the pilot has not updated the sim', () => {
    expect(navdataStatusOf(navigraph('2610'), on('2026-10-29'))).toMatchObject({
      cycle: '2610',
      calendarCycle: '2611',
      state: 'behind'
    })
  })

  it('is not behind for a package installed early, ahead of its effective date', () => {
    expect(navdataStatusOf(navigraph('2611'), on('2026-10-20'))).toMatchObject({
      calendarCycle: '2610',
      state: 'current'
    })
  })

  it('compares across a new year: 2513 against 2601', () => {
    expect(navdataStatusOf(navigraph('2513'), on('2026-01-22'))).toMatchObject({
      calendarCycle: '2601',
      state: 'behind'
    })
  })

  it('has no cycle to compare for the sim’s own data', () => {
    expect(navdataStatusOf({ source: 'default' }, on('2026-10-29'))).toEqual({
      source: 'default',
      cycle: null,
      revision: null,
      validTo: null,
      calendarCycle: '2611',
      state: 'default'
    })
  })
})
