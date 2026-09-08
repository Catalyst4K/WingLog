import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createDb, type WingLogDb } from './client'
import {
  getAltitudeUnit,
  getGsxSettings,
  getLastSyncCompletedAt,
  getSetting,
  getSimbriefUsername,
  getTheme,
  getWindSpeedUnit,
  setAltitudeUnit,
  setGsxSettings,
  setLastSyncCompletedAt,
  setSetting,
  setSimbriefUsername,
  setTheme,
  setWindSpeedUnit
} from './settings-repo'

describe('settings repo', () => {
  let db: WingLogDb

  beforeEach(() => {
    const created = createDb(':memory:')
    migrate(created.db, { migrationsFolder: 'drizzle' })
    db = created.db
  })

  it('returns undefined for an unset key', () => {
    expect(getSetting(db, 'nope')).toBeUndefined()
    expect(getSimbriefUsername(db)).toBeUndefined()
  })

  it('round-trips a generic setting', () => {
    setSetting(db, 'someKey', 'someValue')
    expect(getSetting(db, 'someKey')).toBe('someValue')
  })

  it('overwrites an existing setting rather than duplicating it', () => {
    setSetting(db, 'someKey', 'first')
    setSetting(db, 'someKey', 'second')
    expect(getSetting(db, 'someKey')).toBe('second')
  })

  it('round-trips the SimBrief username', () => {
    setSimbriefUsername(db, 'LandingHangar711')
    expect(getSimbriefUsername(db)).toBe('LandingHangar711')
  })

  it('defaults the altitude unit to ft when never set', () => {
    expect(getAltitudeUnit(db)).toBe('ft')
  })

  it('round-trips the altitude unit', () => {
    setAltitudeUnit(db, 'm')
    expect(getAltitudeUnit(db)).toBe('m')
    setAltitudeUnit(db, 'hybrid')
    expect(getAltitudeUnit(db)).toBe('hybrid')
  })

  it('defaults the wind speed unit to kt when never set', () => {
    expect(getWindSpeedUnit(db)).toBe('kt')
  })

  it('round-trips the wind speed unit', () => {
    setWindSpeedUnit(db, 'mps')
    expect(getWindSpeedUnit(db)).toBe('mps')
    setWindSpeedUnit(db, 'kt')
    expect(getWindSpeedUnit(db)).toBe('kt')
  })

  it('defaults the theme to system when never set', () => {
    expect(getTheme(db)).toBe('system')
  })

  it('round-trips the theme', () => {
    setTheme(db, 'dark')
    expect(getTheme(db)).toBe('dark')
    setTheme(db, 'light')
    expect(getTheme(db)).toBe('light')
    setTheme(db, 'system')
    expect(getTheme(db)).toBe('system')
  })

  it('defaults GSX settings to disabled, no folder, USD display', () => {
    expect(getGsxSettings(db)).toEqual({ enabled: false, folderPath: null, displayCurrency: 'USD' })
  })

  it('round-trips GSX settings including display currency', () => {
    setGsxSettings(db, { enabled: true, folderPath: 'C:\\GSX\\Receipts', displayCurrency: 'GBP' })
    expect(getGsxSettings(db)).toEqual({
      enabled: true,
      folderPath: 'C:\\GSX\\Receipts',
      displayCurrency: 'GBP'
    })
  })

  it('defaults the last-synced-completed timestamp to null when never set', () => {
    expect(getLastSyncCompletedAt(db)).toBeNull()
  })

  it('round-trips the last-synced-completed timestamp', () => {
    setLastSyncCompletedAt(db, '2026-09-06T12:00:00.000Z')
    expect(getLastSyncCompletedAt(db)).toBe('2026-09-06T12:00:00.000Z')
  })

  it('treats clearing it back to an empty string as null again, same as GSX folder path', () => {
    setLastSyncCompletedAt(db, '2026-09-06T12:00:00.000Z')
    setLastSyncCompletedAt(db, '')
    expect(getLastSyncCompletedAt(db)).toBeNull()
  })
})
