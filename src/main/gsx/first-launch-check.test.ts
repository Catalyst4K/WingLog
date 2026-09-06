import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createDb, type FlightdeckDb } from '../db/client'
import { getGsxSettings, hasCheckedGsxFirstLaunch, setGsxSettings } from '../db/settings-repo'
import { checkGsxFirstLaunch } from './first-launch-check'

// defaultGsxReceiptsPath (gsx/default-path.ts) reads process.env.APPDATA directly and
// only resolves on win32 — overriding APPDATA to a real temp dir, then creating or not
// creating the exact subpath it builds, exercises both branches against the real
// filesystem rather than mocking the module. process.platform is forced to 'win32' too:
// `npm test` normally runs on Windows locally (CLAUDE.md's Electron-as-Node runner), but
// CI's build job runs on ubuntu-latest, where the real platform check would silently
// short-circuit every case here to "not found" regardless of APPDATA.
describe('checkGsxFirstLaunch', () => {
  let db: FlightdeckDb
  let tempDir: string
  let originalAppData: string | undefined
  let originalPlatform: NodeJS.Platform

  beforeEach(() => {
    const created = createDb(':memory:')
    migrate(created.db, { migrationsFolder: 'drizzle' })
    db = created.db
    tempDir = mkdtempSync(join(tmpdir(), 'flightdeck-gsx-first-launch-'))
    originalAppData = process.env.APPDATA
    process.env.APPDATA = tempDir
    originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
  })

  afterEach(() => {
    if (originalAppData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = originalAppData
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('auto-enables GSX when the expected receipts folder exists', () => {
    const receiptsPath = join(tempDir, 'Virtuali', 'GSX', 'Receipts')
    mkdirSync(receiptsPath, { recursive: true })

    const result = checkGsxFirstLaunch(db)

    expect(result).toEqual({ found: true })
    expect(getGsxSettings(db)).toEqual({ enabled: true, folderPath: receiptsPath, displayCurrency: 'USD' })
    expect(hasCheckedGsxFirstLaunch(db)).toBe(true)
  })

  it('leaves GSX off when the expected receipts folder does not exist', () => {
    const result = checkGsxFirstLaunch(db)

    expect(result).toEqual({ found: false })
    expect(getGsxSettings(db)).toEqual({ enabled: false, folderPath: null, displayCurrency: 'USD' })
    expect(hasCheckedGsxFirstLaunch(db)).toBe(true)
  })

  it('never runs the check twice, even if called again', () => {
    checkGsxFirstLaunch(db)
    expect(checkGsxFirstLaunch(db)).toBeNull()
  })

  it('does not re-enable GSX on a second call after the user has since disabled it', () => {
    const receiptsPath = join(tempDir, 'Virtuali', 'GSX', 'Receipts')
    mkdirSync(receiptsPath, { recursive: true })
    checkGsxFirstLaunch(db)

    // Simulate the user turning it back off in Settings after the auto-enable.
    setGsxSettings(db, { enabled: false, folderPath: receiptsPath, displayCurrency: 'USD' })

    expect(checkGsxFirstLaunch(db)).toBeNull()
    expect(getGsxSettings(db).enabled).toBe(false)
  })
})
