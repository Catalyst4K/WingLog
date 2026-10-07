/**
 * The app's settings, one key-value row each in `app_setting`. Each typed getter returns a safe
 * default for a missing or unknown stored value (a hand-edited row, or one from a newer version), so
 * a bad row never reaches the UI.
 */
import { eq } from 'drizzle-orm'
import type {
  AltitudeUnit,
  AppLanguage,
  BeyondAtcSettings,
  GsxRemoteSettings,
  GsxSettings,
  LandingDistanceUnit,
  MapLanguage,
  Theme,
  UpdateSettings,
  TrackingSettings,
  WeightUnit,
  WindSpeedUnit
} from '@shared/ipc'
import { appSetting } from './schema'
import type { WingLogDb } from './client'

const SIMBRIEF_USERNAME_KEY = 'simbriefUsername'
const WEIGHT_UNIT_KEY = 'weightUnit'
const ALTITUDE_UNIT_KEY = 'altitudeUnit'
const WIND_SPEED_UNIT_KEY = 'windSpeedUnit'
const MAP_LANGUAGE_KEY = 'mapLanguage'
const APP_LANGUAGE_KEY = 'appLanguage'

const MAP_LANGUAGES: readonly MapLanguage[] = ['local', 'en', 'de', 'es', 'fr', 'it', 'ru']
const APP_LANGUAGES: readonly AppLanguage[] = ['system', 'en', 'de', 'es', 'fr', 'it', 'ru']
const LANDING_DISTANCE_UNIT_KEY = 'landingDistanceUnit'
const THEME_KEY = 'theme'
const TRACKING_AUTO_START_KEY = 'trackingAutoStart'
const TRACKING_AUTO_FINISH_KEY = 'trackingAutoFinish'
const GSX_ENABLED_KEY = 'gsxEnabled'
const GSX_FOLDER_PATH_KEY = 'gsxFolderPath'
const GSX_DISPLAY_CURRENCY_KEY = 'gsxDisplayCurrency'
const GSX_FIRST_LAUNCH_CHECKED_KEY = 'gsxFirstLaunchChecked'
// GSX Remote Control (docs/plans/gsx-remote-control.md) — unrelated to the GSX_* keys
// above, which are the file-based receipts feature.
const GSX_REMOTE_ENABLED_KEY = 'gsxRemoteEnabled'
const GSX_REMOTE_HOST_KEY = 'gsxRemoteHost'
const GSX_REMOTE_PORT_KEY = 'gsxRemotePort'
const BEYONDATC_ENABLED_KEY = 'beyondAtcEnabled'
const BEYONDATC_HOST_KEY = 'beyondAtcHost'
const UPDATE_CHECK_ENABLED_KEY = 'updateCheckEnabled'
const UPDATE_SKIPPED_VERSION_KEY = 'updateSkippedVersion'

/**
 * Reads one raw setting.
 *
 * @param db The database.
 * @param key The setting's key.
 * @returns The stored text, or undefined when it was never set.
 */
export function getSetting(db: WingLogDb, key: string): string | undefined {
  return db.select().from(appSetting).where(eq(appSetting.key, key)).get()?.value
}

/**
 * Stores one raw setting, replacing any earlier value.
 *
 * @param db The database.
 * @param key The setting's key.
 * @param value The text to store.
 */
export function setSetting(db: WingLogDb, key: string, value: string): void {
  db.insert(appSetting)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSetting.key, set: { value } })
    .run()
}

/**
 * The pilot's SimBrief username.
 *
 * @param db The database.
 * @returns The username, or undefined when not set.
 */
export function getSimbriefUsername(db: WingLogDb): string | undefined {
  return getSetting(db, SIMBRIEF_USERNAME_KEY)
}

/**
 * Stores the pilot's SimBrief username.
 *
 * @param db The database.
 * @param username The username.
 */
export function setSimbriefUsername(db: WingLogDb, username: string): void {
  setSetting(db, SIMBRIEF_USERNAME_KEY, username)
}

/**
 * The weight unit shown in the UI: pounds unless kilograms were chosen.
 *
 * @param db The database.
 * @returns 'kg' or 'lb'.
 */
export function getWeightUnit(db: WingLogDb): WeightUnit {
  return getSetting(db, WEIGHT_UNIT_KEY) === 'kg' ? 'kg' : 'lb'
}

/**
 * Stores the weight unit.
 *
 * @param db The database.
 * @param unit The unit.
 */
export function setWeightUnit(db: WingLogDb, unit: WeightUnit): void {
  setSetting(db, WEIGHT_UNIT_KEY, unit)
}

/**
 * The altitude unit shown in the UI: feet unless metres or hybrid were chosen.
 *
 * @param db The database.
 * @returns 'ft', 'm' or 'hybrid'.
 */
export function getAltitudeUnit(db: WingLogDb): AltitudeUnit {
  const value = getSetting(db, ALTITUDE_UNIT_KEY)
  return value === 'm' || value === 'hybrid' ? value : 'ft'
}

/**
 * Stores the altitude unit.
 *
 * @param db The database.
 * @param unit The unit.
 */
export function setAltitudeUnit(db: WingLogDb, unit: AltitudeUnit): void {
  setSetting(db, ALTITUDE_UNIT_KEY, unit)
}

/** Defaults to English (docs/plans/map-language-and-declutter.md) — a stored value that isn't
 *  a known language (a hand-edited or future-version row) also reads as English.
 *
 * @param db The database.
 * @returns The map's label language.
 */
export function getMapLanguage(db: WingLogDb): MapLanguage {
  const value = getSetting(db, MAP_LANGUAGE_KEY)
  return MAP_LANGUAGES.find((l) => l === value) ?? 'en'
}

/**
 * Validated here rather than trusted from the renderer; an unknown value is ignored.
 *
 * @param db The database.
 * @param language The language, from the renderer.
 */
export function setMapLanguage(db: WingLogDb, language: MapLanguage): void {
  if (!MAP_LANGUAGES.includes(language)) return
  setSetting(db, MAP_LANGUAGE_KEY, language)
}

/** Defaults to 'system' (docs/plans/v1-2.md Part 3, decisions.md 2026-09-20) — resolved to
 *  an actual language client-side (app-language.ts's resolveAppLanguage), against the OS's
 *  own locale, falling back to English. A stored value that isn't a known language (a
 *  hand-edited or future-version row) also reads as 'system'.
 *
 * @param db The database.
 * @returns The app's language, or 'system'.
 */
export function getAppLanguage(db: WingLogDb): AppLanguage {
  const value = getSetting(db, APP_LANGUAGE_KEY)
  return APP_LANGUAGES.find((l) => l === value) ?? 'system'
}

/**
 * Validated here rather than trusted from the renderer; an unknown value is ignored.
 *
 * @param db The database.
 * @param language The language, from the renderer.
 */
export function setAppLanguage(db: WingLogDb, language: AppLanguage): void {
  if (!APP_LANGUAGES.includes(language)) return
  setSetting(db, APP_LANGUAGE_KEY, language)
}

/**
 * The wind speed unit shown in the UI: knots unless metres per second were chosen.
 *
 * @param db The database.
 * @returns 'kt' or 'mps'.
 */
export function getWindSpeedUnit(db: WingLogDb): WindSpeedUnit {
  return getSetting(db, WIND_SPEED_UNIT_KEY) === 'mps' ? 'mps' : 'kt'
}

/**
 * Stores the wind speed unit.
 *
 * @param db The database.
 * @param unit The unit.
 */
export function setWindSpeedUnit(db: WingLogDb, unit: WindSpeedUnit): void {
  setSetting(db, WIND_SPEED_UNIT_KEY, unit)
}

/** Defaults to 'ft' — deliberately different from windSpeedUnit/altitudeUnit's own
 *  defaults (docs/plans/logbook-detail-improvements.md, item 4: Callum's call).
 *
 * @param db The database.
 * @returns 'ft' or 'm'.
 */
export function getLandingDistanceUnit(db: WingLogDb): LandingDistanceUnit {
  return getSetting(db, LANDING_DISTANCE_UNIT_KEY) === 'm' ? 'm' : 'ft'
}

/**
 * Stores the landing distance unit.
 *
 * @param db The database.
 * @param unit The unit.
 */
export function setLandingDistanceUnit(db: WingLogDb, unit: LandingDistanceUnit): void {
  setSetting(db, LANDING_DISTANCE_UNIT_KEY, unit)
}

/**
 * The colour theme: the OS's unless light or dark was chosen.
 *
 * @param db The database.
 * @returns 'light', 'dark' or 'system'.
 */
export function getTheme(db: WingLogDb): Theme {
  const value = getSetting(db, THEME_KEY)
  return value === 'light' || value === 'dark' ? value : 'system'
}

/**
 * Stores the colour theme.
 *
 * @param db The database.
 * @param theme The theme.
 */
export function setTheme(db: WingLogDb, theme: Theme): void {
  setSetting(db, THEME_KEY, theme)
}

/**
 * Both default on — only an explicit '0' switches either off.
 *
 * @param db The database.
 * @returns Whether tracking starts and finishes by itself.
 */
export function getTrackingSettings(db: WingLogDb): TrackingSettings {
  return {
    autoStart: getSetting(db, TRACKING_AUTO_START_KEY) !== '0',
    autoFinish: getSetting(db, TRACKING_AUTO_FINISH_KEY) !== '0'
  }
}

/**
 * Stores the tracking settings.
 *
 * @param db The database.
 * @param settings Auto-start and auto-finish.
 */
export function setTrackingSettings(db: WingLogDb, settings: TrackingSettings): void {
  setSetting(db, TRACKING_AUTO_START_KEY, settings.autoStart ? '1' : '0')
  setSetting(db, TRACKING_AUTO_FINISH_KEY, settings.autoFinish ? '1' : '0')
}

/** Default off, empty path (docs/decisions.md, gsx-invoices entry) — someone without GSX
 *  should never see anything from this feature. Auto-enabled only by
 *  checkGsxFirstLaunch below, and only when the expected receipts folder is actually
 *  found on disk on the app's first-ever launch (flight-test-findings-2026-09-06.md #4)
 *  — never silently, and never past that one check.
 *
 * @param db The database.
 * @returns Whether GSX invoices are on, the receipts folder, and the display currency.
 */
export function getGsxSettings(db: WingLogDb): GsxSettings {
  return {
    enabled: getSetting(db, GSX_ENABLED_KEY) === '1',
    folderPath: getSetting(db, GSX_FOLDER_PATH_KEY) || null,
    displayCurrency: getSetting(db, GSX_DISPLAY_CURRENCY_KEY) || 'USD'
  }
}

/**
 * Stores the GSX invoice settings.
 *
 * @param db The database.
 * @param settings On or off, the receipts folder, and the display currency.
 */
export function setGsxSettings(db: WingLogDb, settings: GsxSettings): void {
  setSetting(db, GSX_ENABLED_KEY, settings.enabled ? '1' : '0')
  setSetting(db, GSX_FOLDER_PATH_KEY, settings.folderPath ?? '')
  setSetting(db, GSX_DISPLAY_CURRENCY_KEY, settings.displayCurrency || 'USD')
}

/** Whether checkGsxFirstLaunch (gsx/first-launch-check.ts) has already run once — gates
 *  the check to the app's actual first-ever launch, not every launch or every Settings
 *  visit.
 *
 * @param db The database.
 * @returns True once the check has run.
 */
export function hasCheckedGsxFirstLaunch(db: WingLogDb): boolean {
  return getSetting(db, GSX_FIRST_LAUNCH_CHECKED_KEY) === '1'
}

/**
 * Records that the first-launch GSX check has run.
 *
 * @param db The database.
 */
export function setCheckedGsxFirstLaunch(db: WingLogDb): void {
  setSetting(db, GSX_FIRST_LAUNCH_CHECKED_KEY, '1')
}

/** Default off, localhost, port 8744 — GSX's own real default Remote Client port (Callum,
 *  2026-09-21, confirmed directly; the community-cited 8090 is not it — docs/gsx-notes.md).
 *  Still genuinely user-configurable in GSX's own settings, so the field stays editable —
 *  this is a sensible pre-fill, not treated as the only possible value.
 *
 * @param db The database.
 * @returns On or off, the host and the port.
 */
export function getGsxRemoteSettings(db: WingLogDb): GsxRemoteSettings {
  const port = getSetting(db, GSX_REMOTE_PORT_KEY)
  return {
    enabled: getSetting(db, GSX_REMOTE_ENABLED_KEY) === '1',
    host: getSetting(db, GSX_REMOTE_HOST_KEY) || 'localhost',
    port: port ? Number(port) : 8744
  }
}

/**
 * Stores the GSX Remote settings.
 *
 * @param db The database.
 * @param settings On or off, the host and the port (blank for the default).
 */
export function setGsxRemoteSettings(db: WingLogDb, settings: GsxRemoteSettings): void {
  setSetting(db, GSX_REMOTE_ENABLED_KEY, settings.enabled ? '1' : '0')
  setSetting(db, GSX_REMOTE_HOST_KEY, settings.host || 'localhost')
  setSetting(db, GSX_REMOTE_PORT_KEY, settings.port ? String(settings.port) : '')
}

/** Default off, localhost — unlike GSX's Remote Client, BeyondATC's own local WebSocket
 *  server port (41716, BeyondAtcService's BEYONDATC_PORT) isn't user-configurable on
 *  BeyondATC's own side (confirmed live, winglog-backend's docs/beyondatc-notes.md), so
 *  there's no port setting to store here.
 *
 * @param db The database.
 * @returns On or off, and the host.
 */
export function getBeyondAtcSettings(db: WingLogDb): BeyondAtcSettings {
  return {
    enabled: getSetting(db, BEYONDATC_ENABLED_KEY) === '1',
    host: getSetting(db, BEYONDATC_HOST_KEY) || 'localhost'
  }
}

/**
 * Stores the BeyondATC settings.
 *
 * @param db The database.
 * @param settings On or off, and the host (blank for localhost).
 */
export function setBeyondAtcSettings(db: WingLogDb, settings: BeyondAtcSettings): void {
  setSetting(db, BEYONDATC_ENABLED_KEY, settings.enabled ? '1' : '0')
  setSetting(db, BEYONDATC_HOST_KEY, settings.host || 'localhost')
}

/** Per-table sync cursor (winglog-backend/docs/plans/cloud-sync.md's pull-then-push
 *  protocol) — null means "never synced", so a pull fetches everything and a push sends
 *  every local row. Updated only after both directions succeed for a sync run, so a
 *  failed sync retries cleanly rather than marking partial progress as done.
 *
 * @param db The database.
 * @param table The synced table.
 * @returns The cursor as an ISO time, or null.
 */
export function getLastSyncedAt(db: WingLogDb, table: string): string | null {
  return getSetting(db, `lastSyncedAt:${table}`) ?? null
}

/**
 * Moves one table's sync cursor.
 *
 * @param db The database.
 * @param table The synced table.
 * @param isoTimestamp The new cursor.
 */
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
 *  GSX_FOLDER_PATH_KEY above.
 *
 * @param db The database.
 * @returns An ISO time, or null.
 */
export function getLastSyncCompletedAt(db: WingLogDb): string | null {
  return getSetting(db, LAST_SYNC_COMPLETED_KEY) || null
}

/**
 * Records when a full sync last finished.
 *
 * @param db The database.
 * @param isoTimestamp When the sync finished, or '' to clear it.
 */
export function setLastSyncCompletedAt(db: WingLogDb, isoTimestamp: string): void {
  setSetting(db, LAST_SYNC_COMPLETED_KEY, isoTimestamp)
}

/** A remembered `title` -> fleet aircraft mapping (free-flight-tracking.md's aircraft-
 *  resolution step 2: "I've seen this aircraft before, it's my G-EUYY") — namespaced
 *  app_setting rows, same pattern as getLastSyncedAt's per-table cursor above, rather than
 *  a new table for what's a small map keyed by an add-on's own title string.
 *
 * @param title The sim aircraft's title.
 * @returns The setting's key.
 */
function titleAircraftKey(title: string): string {
  return `freeFlightTitleAircraft:${title}`
}

/**
 * The fleet aircraft remembered for a sim aircraft title.
 *
 * @param db The database.
 * @param title The sim aircraft's title.
 * @returns The fleet aircraft's id, or undefined.
 */
export function getAircraftIdForTitle(db: WingLogDb, title: string): number | undefined {
  const raw = getSetting(db, titleAircraftKey(title))
  if (!raw) return undefined
  const id = Number(raw)
  return Number.isInteger(id) ? id : undefined
}

/**
 * Remembers which fleet aircraft a sim aircraft title is.
 *
 * @param db The database.
 * @param title The sim aircraft's title.
 * @param aircraftId The fleet aircraft.
 */
export function rememberAircraftForTitle(db: WingLogDb, title: string, aircraftId: number): void {
  setSetting(db, titleAircraftKey(title), String(aircraftId))
}

/** The GitHub update check (winglog-backend's docs/plans/update-check.md): on unless
 *  switched off — only an explicit '0' disables it.
 *
 * @param db The database.
 * @returns Whether the update check runs.
 */
export function getUpdateSettings(db: WingLogDb): UpdateSettings {
  return { checkEnabled: getSetting(db, UPDATE_CHECK_ENABLED_KEY) !== '0' }
}

/**
 * Stores the update check setting.
 *
 * @param db The database.
 * @param settings Whether the update check runs.
 */
export function setUpdateSettings(db: WingLogDb, settings: UpdateSettings): void {
  setSetting(db, UPDATE_CHECK_ENABLED_KEY, settings.checkEnabled ? '1' : '0')
}

/**
 * The release the pilot chose to skip.
 *
 * @param db The database.
 * @returns The version, or null.
 */
export function getSkippedUpdateVersion(db: WingLogDb): string | null {
  return getSetting(db, UPDATE_SKIPPED_VERSION_KEY) ?? null
}

/**
 * Records a release the pilot chose to skip.
 *
 * @param db The database.
 * @param version The release to stop offering.
 */
export function setSkippedUpdateVersion(db: WingLogDb, version: string): void {
  setSetting(db, UPDATE_SKIPPED_VERSION_KEY, version)
}
