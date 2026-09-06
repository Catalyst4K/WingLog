import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createDb, type FlightdeckDb } from './client'
import {
  getAltitudeUnit,
  getGsxSettings,
  getSetting,
  getSimbriefUsername,
  getWindSpeedUnit,
  setAltitudeUnit,
  setGsxSettings,
  setSetting,
  setSimbriefUsername,
  setWindSpeedUnit
} from './settings-repo'

describe('settings repo', () => {
  let db: FlightdeckDb

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

  it('defaults GSX settings to disabled, no folder, USD display', () => {
    expect(getGsxSettings(db)).toEqual({ enabled: false, folderPath: null, displayCurrency: 'USD' })
  })

  it('round-trips GSX settings including display currency', () => {
    setGsxSettings(db, { enabled: true, folderPath: 'C:\\GSX\\Receipts', displayCurrency: 'GBP' })
    expect(getGsxSettings(db)).toEqual({ enabled: true, folderPath: 'C:\\GSX\\Receipts', displayCurrency: 'GBP' })
  })
})
