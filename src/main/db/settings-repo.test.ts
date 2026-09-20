import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createDb, type WingLogDb } from './client'
import { appSetting } from './schema'
import {
  getAircraftIdForTitle,
  getAltitudeUnit,
  getAppLanguage,
  getGsxSettings,
  getLandingDistanceUnit,
  getLastSyncCompletedAt,
  getLastSyncedAt,
  getSetting,
  getSimbriefUsername,
  getTheme,
  getWeightUnit,
  getMapLanguage,
  getWindSpeedUnit,
  hasCheckedGsxFirstLaunch,
  rememberAircraftForTitle,
  setAltitudeUnit,
  setAppLanguage,
  setCheckedGsxFirstLaunch,
  setGsxSettings,
  setLandingDistanceUnit,
  setLastSyncCompletedAt,
  setLastSyncedAt,
  setSetting,
  setSimbriefUsername,
  setTheme,
  setWeightUnit,
  setMapLanguage,
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

  it('defaults the map language to English, and round-trips every supported language', () => {
    expect(getMapLanguage(db)).toBe('en')
    for (const language of ['local', 'de', 'es', 'fr', 'it', 'ru', 'en'] as const) {
      setMapLanguage(db, language)
      expect(getMapLanguage(db)).toBe(language)
    }
  })

  it('ignores an unknown map language on write, and reads a corrupt stored value as English', () => {
    setMapLanguage(db, 'de')
    setMapLanguage(db, 'xx' as never)
    expect(getMapLanguage(db)).toBe('de')
    db.insert(appSetting).values({ key: 'mapLanguage', value: 'klingon' }).onConflictDoUpdate({ target: appSetting.key, set: { value: 'klingon' } }).run()
    expect(getMapLanguage(db)).toBe('en')
  })

  it('defaults the app language to "system", and round-trips every supported language', () => {
    expect(getAppLanguage(db)).toBe('system')
    for (const language of ['de', 'es', 'fr', 'it', 'ru', 'en', 'system'] as const) {
      setAppLanguage(db, language)
      expect(getAppLanguage(db)).toBe(language)
    }
  })

  it('ignores an unknown app language on write, and reads a corrupt stored value as "system"', () => {
    setAppLanguage(db, 'de')
    setAppLanguage(db, 'xx' as never)
    expect(getAppLanguage(db)).toBe('de')
    db.insert(appSetting).values({ key: 'appLanguage', value: 'klingon' }).onConflictDoUpdate({ target: appSetting.key, set: { value: 'klingon' } }).run()
    expect(getAppLanguage(db)).toBe('system')
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

  it('defaults the landing distance unit to ft when never set', () => {
    expect(getLandingDistanceUnit(db)).toBe('ft')
  })

  it('round-trips the landing distance unit', () => {
    setLandingDistanceUnit(db, 'm')
    expect(getLandingDistanceUnit(db)).toBe('m')
    setLandingDistanceUnit(db, 'ft')
    expect(getLandingDistanceUnit(db)).toBe('ft')
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

  it('defaults a table sync cursor to null when never set', () => {
    expect(getLastSyncedAt(db, 'aircraft')).toBeNull()
  })

  it('round-trips a per-table sync cursor independently of other tables', () => {
    setLastSyncedAt(db, 'aircraft', '2026-09-06T12:00:00.000Z')
    expect(getLastSyncedAt(db, 'aircraft')).toBe('2026-09-06T12:00:00.000Z')
    expect(getLastSyncedAt(db, 'flight')).toBeNull()
  })

  describe('title -> fleet aircraft memory (free-flight-tracking.md)', () => {
    it('returns undefined for a title never seen before', () => {
      expect(getAircraftIdForTitle(db, 'FenixA320 IAE SL')).toBeUndefined()
    })

    it('round-trips a remembered title -> aircraft mapping', () => {
      rememberAircraftForTitle(db, 'FenixA320 IAE SL', 7)
      expect(getAircraftIdForTitle(db, 'FenixA320 IAE SL')).toBe(7)
    })

    it('keeps two different titles independent', () => {
      rememberAircraftForTitle(db, 'FenixA320 IAE SL', 7)
      rememberAircraftForTitle(db, 'A350-900 (Default Cabin)', 9)
      expect(getAircraftIdForTitle(db, 'FenixA320 IAE SL')).toBe(7)
      expect(getAircraftIdForTitle(db, 'A350-900 (Default Cabin)')).toBe(9)
    })

    it('overwrites a stale mapping when the same title is remembered again', () => {
      rememberAircraftForTitle(db, 'FenixA320 IAE SL', 7)
      rememberAircraftForTitle(db, 'FenixA320 IAE SL', 12)
      expect(getAircraftIdForTitle(db, 'FenixA320 IAE SL')).toBe(12)
    })
  })
})
