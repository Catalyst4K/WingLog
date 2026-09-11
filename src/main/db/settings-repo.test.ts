import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createDb, type WingLogDb } from './client'
import {
  getAltitudeUnit,
  getGsxSettings,
  getLandingThresholds,
  getLastSyncCompletedAt,
  getLastSyncedAt,
  getSetting,
  getSimbriefUsername,
  getTheme,
  getWeightUnit,
  getWindSpeedUnit,
  hasCheckedGsxFirstLaunch,
  setAltitudeUnit,
  setCheckedGsxFirstLaunch,
  setGsxSettings,
  setLandingThresholds,
  setLastSyncCompletedAt,
  setLastSyncedAt,
  setSetting,
  setSimbriefUsername,
  setTheme,
  setWeightUnit,
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

  it('defaults the weight unit to lb when never set', () => {
    expect(getWeightUnit(db)).toBe('lb')
  })

  it('round-trips the weight unit', () => {
    setWeightUnit(db, 'kg')
    expect(getWeightUnit(db)).toBe('kg')
    setWeightUnit(db, 'lb')
    expect(getWeightUnit(db)).toBe('lb')
  })

  it('defaults the GSX first-launch check to not-yet-run', () => {
    expect(hasCheckedGsxFirstLaunch(db)).toBe(false)
  })

  it('marks the GSX first-launch check as run', () => {
    setCheckedGsxFirstLaunch(db)
    expect(hasCheckedGsxFirstLaunch(db)).toBe(true)
  })

  it('defaults landing thresholds when never set', () => {
    expect(getLandingThresholds(db)).toEqual({ firmFpm: 480, hardFpm: 600 })
  })

  it('round-trips landing thresholds', () => {
    setLandingThresholds(db, { firmFpm: 400, hardFpm: 550 })
    expect(getLandingThresholds(db)).toEqual({ firmFpm: 400, hardFpm: 550 })
  })

  it('falls back to defaults for a stored threshold that is not a positive number', () => {
    setSetting(db, 'firmLandingFpm', 'not-a-number')
    setSetting(db, 'hardLandingFpm', '-100')
    expect(getLandingThresholds(db)).toEqual({ firmFpm: 480, hardFpm: 600 })
  })

  it('defaults a table sync cursor to null when never set', () => {
    expect(getLastSyncedAt(db, 'aircraft')).toBeNull()
  })

  it('round-trips a per-table sync cursor independently of other tables', () => {
    setLastSyncedAt(db, 'aircraft', '2026-09-06T12:00:00.000Z')
    expect(getLastSyncedAt(db, 'aircraft')).toBe('2026-09-06T12:00:00.000Z')
    expect(getLastSyncedAt(db, 'flight')).toBeNull()
  })
})
