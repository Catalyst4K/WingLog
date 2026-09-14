import { eq } from 'drizzle-orm'
import type { AltitudeUnit, GsxSettings, LandingDistanceUnit, Theme, WeightUnit, WindSpeedUnit } from '@shared/ipc'
import { appSetting } from './schema'
import type { WingLogDb } from './client'

const SIMBRIEF_USERNAME_KEY = 'simbriefUsername'
const WEIGHT_UNIT_KEY = 'weightUnit'
const ALTITUDE_UNIT_KEY = 'altitudeUnit'
const WIND_SPEED_UNIT_KEY = 'windSpeedUnit'
const LANDING_DISTANCE_UNIT_KEY = 'landingDistanceUnit'
const THEME_KEY = 'theme'
const GSX_ENABLED_KEY = 'gsxEnabled'
const GSX_FOLDER_PATH_KEY = 'gsxFolderPath'
const GSX_DISPLAY_CURRENCY_KEY = 'gsxDisplayCurrency'
const GSX_FIRST_LAUNCH_CHECKED_KEY = 'gsxFirstLaunchChecked'

export function getSetting(db: WingLogDb, key: string): string | undefined {
  return db.select().from(appSetting).where(eq(appSetting.key, key)).get()?.value
}

export function setSetting(db: WingLogDb, key: string, value: string): void {
  db.insert(appSetting)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSetting.key, set: { value } })
    .run()
}

export function getSimbriefUsername(db: WingLogDb): string | undefined {
  return getSetting(db, SIMBRIEF_USERNAME_KEY)
}

export function setSimbriefUsername(db: WingLogDb, username: string): void {
  setSetting(db, SIMBRIEF_USERNAME_KEY, username)
}

export function getWeightUnit(db: WingLogDb): WeightUnit {
  return getSetting(db, WEIGHT_UNIT_KEY) === 'kg' ? 'kg' : 'lb'
}

export function setWeightUnit(db: WingLogDb, unit: WeightUnit): void {
  setSetting(db, WEIGHT_UNIT_KEY, unit)
}

export function getAltitudeUnit(db: WingLogDb): AltitudeUnit {
  const value = getSetting(db, ALTITUDE_UNIT_KEY)
  return value === 'm' || value === 'hybrid' ? value : 'ft'
}

export function setAltitudeUnit(db: WingLogDb, unit: AltitudeUnit): void {
  setSetting(db, ALTITUDE_UNIT_KEY, unit)
}

export function getWindSpeedUnit(db: WingLogDb): WindSpeedUnit {
  return getSetting(db, WIND_SPEED_UNIT_KEY) === 'mps' ? 'mps' : 'kt'
}

export function setWindSpeedUnit(db: WingLogDb, unit: WindSpeedUnit): void {
  setSetting(db, WIND_SPEED_UNIT_KEY, unit)
}

/** Defaults to 'ft' — deliberately different from windSpeedUnit/altitudeUnit's own
 *  defaults (docs/plans/logbook-detail-improvements.md, item 4: Callum's call). */
export function getLandingDistanceUnit(db: WingLogDb): LandingDistanceUnit {
  return getSetting(db, LANDING_DISTANCE_UNIT_KEY) === 'm' ? 'm' : 'ft'
}

export function setLandingDistanceUnit(db: WingLogDb, unit: LandingDistanceUnit): void {
  setSetting(db, LANDING_DISTANCE_UNIT_KEY, unit)
}

export function getTheme(db: WingLogDb): Theme {
  const value = getSetting(db, THEME_KEY)
  return value === 'light' || value === 'dark' ? value : 'system'
}

export function setTheme(db: WingLogDb, theme: Theme): void {
  setSetting(db, THEME_KEY, theme)
}

/** Default off, empty path (docs/decisions.md, gsx-invoices entry) — someone without GSX
 *  should never see anything from this feature. Auto-enabled only by
 *  checkGsxFirstLaunch below, and only when the expected receipts folder is actually
 *  found on disk on the app's first-ever launch (flight-test-findings-2026-09-06.md #4)
 *  — never silently, and never past that one check. */
export function getGsxSettings(db: WingLogDb): GsxSettings {
  return {
    enabled: getSetting(db, GSX_ENABLED_KEY) === '1',
    folderPath: getSetting(db, GSX_FOLDER_PATH_KEY) || null,
    displayCurrency: getSetting(db, GSX_DISPLAY_CURRENCY_KEY) || 'USD'
  }
}

export function setGsxSettings(db: WingLogDb, settings: GsxSettings): void {
  setSetting(db, GSX_ENABLED_KEY, settings.enabled ? '1' : '0')
  setSetting(db, GSX_FOLDER_PATH_KEY, settings.folderPath ?? '')
  setSetting(db, GSX_DISPLAY_CURRENCY_KEY, settings.displayCurrency || 'USD')
}

/** Whether checkGsxFirstLaunch (gsx/first-launch-check.ts) has already run once — gates
 *  the check to the app's actual first-ever launch, not every launch or every Settings
 *  visit. */
export function hasCheckedGsxFirstLaunch(db: WingLogDb): boolean {
  return getSetting(db, GSX_FIRST_LAUNCH_CHECKED_KEY) === '1'
}

export function setCheckedGsxFirstLaunch(db: WingLogDb): void {
  setSetting(db, GSX_FIRST_LAUNCH_CHECKED_KEY, '1')
}

/** Per-table sync cursor (flightdeck-backend/docs/plans/cloud-sync.md's pull-then-push
 *  protocol) — null means "never synced", so a pull fetches everything and a push sends
 *  every local row. Updated only after both directions succeed for a sync run, so a
 *  failed sync retries cleanly rather than marking partial progress as done. */
export function getLastSyncedAt(db: WingLogDb, table: string): string | null {
  return getSetting(db, `lastSyncedAt:${table}`) ?? null
}

export function setLastSyncedAt(db: WingLogDb, table: string, isoTimestamp: string): void {
  setSetting(db, `lastSyncedAt:${table}`, isoTimestamp)
}

const LAST_SYNC_COMPLETED_KEY = 'lastSyncCompletedAt'

/** The single timestamp Settings' "Last synced" line shows — distinct from
 *  getLastSyncedAt's per-table cursor above (an internal sync-protocol detail that exists
 *  even mid-sync, per table). This is only ever set once a full sync run has actually
 *  finished, and persists across a restart — CloudSyncController's status was previously
 *  in-memory only, so "Never synced yet." kept showing on every launch regardless of sync
 *  history. Empty string (from clearing on logout) reads back as null, same convention as
 *  GSX_FOLDER_PATH_KEY above. */
export function getLastSyncCompletedAt(db: WingLogDb): string | null {
  return getSetting(db, LAST_SYNC_COMPLETED_KEY) || null
}

export function setLastSyncCompletedAt(db: WingLogDb, isoTimestamp: string): void {
  setSetting(db, LAST_SYNC_COMPLETED_KEY, isoTimestamp)
}
