import { eq } from 'drizzle-orm'
import type { AltitudeUnit, GsxSettings, LandingThresholds, WeightUnit } from '@shared/ipc'
import { appSetting } from './schema'
import type { FlightdeckDb } from './client'

const SIMBRIEF_USERNAME_KEY = 'simbriefUsername'
const WEIGHT_UNIT_KEY = 'weightUnit'
const ALTITUDE_UNIT_KEY = 'altitudeUnit'
const GSX_ENABLED_KEY = 'gsxEnabled'
const GSX_FOLDER_PATH_KEY = 'gsxFolderPath'
const GSX_DISPLAY_CURRENCY_KEY = 'gsxDisplayCurrency'
const FIRM_LANDING_FPM_KEY = 'firmLandingFpm'
const HARD_LANDING_FPM_KEY = 'hardLandingFpm'

// General-aviation-leaning defaults, not universally correct — real published guidance
// varies by aircraft category and airline, and this app spans a C172 to an A380
// (docs/decisions.md, landing-analysis entry). ~600 fpm is a common "log it" trigger
// industry-wide; "firm" sits enough below that to flag something noticeably brisk without
// crying wolf on every slightly-firm-but-fine landing.
const DEFAULT_FIRM_LANDING_FPM = 480
const DEFAULT_HARD_LANDING_FPM = 600

export function getSetting(db: FlightdeckDb, key: string): string | undefined {
  return db.select().from(appSetting).where(eq(appSetting.key, key)).get()?.value
}

export function setSetting(db: FlightdeckDb, key: string, value: string): void {
  db.insert(appSetting)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSetting.key, set: { value } })
    .run()
}

export function getSimbriefUsername(db: FlightdeckDb): string | undefined {
  return getSetting(db, SIMBRIEF_USERNAME_KEY)
}

export function setSimbriefUsername(db: FlightdeckDb, username: string): void {
  setSetting(db, SIMBRIEF_USERNAME_KEY, username)
}

export function getWeightUnit(db: FlightdeckDb): WeightUnit {
  return getSetting(db, WEIGHT_UNIT_KEY) === 'kg' ? 'kg' : 'lb'
}

export function setWeightUnit(db: FlightdeckDb, unit: WeightUnit): void {
  setSetting(db, WEIGHT_UNIT_KEY, unit)
}

export function getAltitudeUnit(db: FlightdeckDb): AltitudeUnit {
  const value = getSetting(db, ALTITUDE_UNIT_KEY)
  return value === 'm' || value === 'hybrid' ? value : 'ft'
}

export function setAltitudeUnit(db: FlightdeckDb, unit: AltitudeUnit): void {
  setSetting(db, ALTITUDE_UNIT_KEY, unit)
}

/** Default off, empty path (docs/decisions.md, gsx-invoices entry) — someone without GSX
 *  should never see anything from this feature, so it stays opt-in rather than trying to
 *  auto-detect-and-enable. */
export function getGsxSettings(db: FlightdeckDb): GsxSettings {
  return {
    enabled: getSetting(db, GSX_ENABLED_KEY) === '1',
    folderPath: getSetting(db, GSX_FOLDER_PATH_KEY) || null,
    displayCurrency: getSetting(db, GSX_DISPLAY_CURRENCY_KEY) || 'USD'
  }
}

export function setGsxSettings(db: FlightdeckDb, settings: GsxSettings): void {
  setSetting(db, GSX_ENABLED_KEY, settings.enabled ? '1' : '0')
  setSetting(db, GSX_FOLDER_PATH_KEY, settings.folderPath ?? '')
  setSetting(db, GSX_DISPLAY_CURRENCY_KEY, settings.displayCurrency || 'USD')
}

export function getLandingThresholds(db: FlightdeckDb): LandingThresholds {
  const firm = Number(getSetting(db, FIRM_LANDING_FPM_KEY))
  const hard = Number(getSetting(db, HARD_LANDING_FPM_KEY))
  return {
    firmFpm: Number.isFinite(firm) && firm > 0 ? firm : DEFAULT_FIRM_LANDING_FPM,
    hardFpm: Number.isFinite(hard) && hard > 0 ? hard : DEFAULT_HARD_LANDING_FPM
  }
}

export function setLandingThresholds(db: FlightdeckDb, thresholds: LandingThresholds): void {
  setSetting(db, FIRM_LANDING_FPM_KEY, String(thresholds.firmFpm))
  setSetting(db, HARD_LANDING_FPM_KEY, String(thresholds.hardFpm))
}

/** Per-table sync cursor (flightdeck-backend/docs/plans/cloud-sync.md's pull-then-push
 *  protocol) — null means "never synced", so a pull fetches everything and a push sends
 *  every local row. Updated only after both directions succeed for a sync run, so a
 *  failed sync retries cleanly rather than marking partial progress as done. */
export function getLastSyncedAt(db: FlightdeckDb, table: string): string | null {
  return getSetting(db, `lastSyncedAt:${table}`) ?? null
}

export function setLastSyncedAt(db: FlightdeckDb, table: string, isoTimestamp: string): void {
  setSetting(db, `lastSyncedAt:${table}`, isoTimestamp)
}
