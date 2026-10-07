/**
 * Settings and first-launch setup IPC: each preference read and written, and the setup dialog's
 * state. Every channel is a query (coding-standards.md §9): plain IPC to the local database. The
 * settings that restart a live connection (GSX Remote, BeyondATC) are with those connections.
 */
import { app, type IpcMain } from 'electron'
import {
  IpcChannels,
  type WeightUnit,
  type AltitudeUnit,
  type MapLanguage,
  type AppLanguage,
  type WindSpeedUnit,
  type LandingDistanceUnit,
  type Theme,
  type TrackingSettings,
  type GsxSettings,
  type UpdateSettings
} from '@shared/ipc'
import type { WingLogDb } from '../db/client'
import type { TrackingController } from '../tracking/TrackingController'
import {
  getSimbriefUsername,
  setSimbriefUsername,
  getWeightUnit,
  setWeightUnit,
  getAltitudeUnit,
  setAltitudeUnit,
  getMapLanguage,
  setMapLanguage,
  getAppLanguage,
  setAppLanguage,
  getWindSpeedUnit,
  setWindSpeedUnit,
  getLandingDistanceUnit,
  setLandingDistanceUnit,
  getTheme,
  setTheme,
  getTrackingSettings,
  setTrackingSettings,
  getGsxSettings,
  setGsxSettings,
  getUpdateSettings,
  setUpdateSettings
} from '../db/settings-repo'
import { setMainLanguage } from '../i18n'
import { checkGsxFirstLaunch } from '../db/gsx-first-launch'
import { getSetupState, getSetupContext, setSetupCompleted } from '../setup/first-run'

/** What the settings channels need. */
export interface SettingsHandlerDeps {
  db: WingLogDb
  /** Takes "Finish flights automatically" as soon as it changes. */
  trackingController: Pick<TrackingController, 'setAutoFinish'>
}

/**
 * Registers the settings and setup channels.
 *
 * @param ipcMain Electron's IPC.
 * @param deps The database, and the tracking controller for auto-finish.
 */
export function registerSettingsHandlers(
  ipcMain: IpcMain,
  { db, trackingController }: SettingsHandlerDeps
): void {
  ipcMain.handle(IpcChannels.settingsGetSimbriefUsername, () => getSimbriefUsername(db) ?? null)

  ipcMain.handle(IpcChannels.settingsSetSimbriefUsername, (_event, username: string) =>
    setSimbriefUsername(db, username)
  )

  ipcMain.handle(IpcChannels.settingsGetWeightUnit, () => getWeightUnit(db))

  ipcMain.handle(IpcChannels.settingsSetWeightUnit, (_event, unit: WeightUnit) => setWeightUnit(db, unit))

  ipcMain.handle(IpcChannels.settingsGetAltitudeUnit, () => getAltitudeUnit(db))

  ipcMain.handle(IpcChannels.settingsSetAltitudeUnit, (_event, unit: AltitudeUnit) =>
    setAltitudeUnit(db, unit)
  )

  ipcMain.handle(IpcChannels.settingsGetMapLanguage, () => getMapLanguage(db))

  ipcMain.handle(IpcChannels.settingsSetMapLanguage, (_event, language: MapLanguage) =>
    setMapLanguage(db, language)
  )

  ipcMain.handle(IpcChannels.settingsGetAppLanguage, () => getAppLanguage(db))

  ipcMain.handle(IpcChannels.settingsSetAppLanguage, (_event, language: AppLanguage) => {
    setAppLanguage(db, language)
    setMainLanguage(language, app.getLocale())
  })

  // Not a stored setting — just what the OS itself reports, for resolving AppLanguage's
  // 'system' value client-side (app-language.ts's resolveAppLanguage).
  ipcMain.handle(IpcChannels.settingsGetSystemLocale, () => app.getLocale())

  ipcMain.handle(IpcChannels.settingsGetWindSpeedUnit, () => getWindSpeedUnit(db))

  ipcMain.handle(IpcChannels.settingsSetWindSpeedUnit, (_event, unit: WindSpeedUnit) =>
    setWindSpeedUnit(db, unit)
  )

  ipcMain.handle(IpcChannels.settingsGetLandingDistanceUnit, () => getLandingDistanceUnit(db))

  ipcMain.handle(IpcChannels.settingsSetLandingDistanceUnit, (_event, unit: LandingDistanceUnit) =>
    setLandingDistanceUnit(db, unit)
  )

  ipcMain.handle(IpcChannels.settingsGetTheme, () => getTheme(db))

  ipcMain.handle(IpcChannels.settingsSetTheme, (_event, theme: Theme) => setTheme(db, theme))

  ipcMain.handle(IpcChannels.settingsGetTracking, () => getTrackingSettings(db))

  ipcMain.handle(IpcChannels.settingsSetTracking, (_event, settings: TrackingSettings) => {
    if (typeof settings?.autoStart !== 'boolean' || typeof settings.autoFinish !== 'boolean') {
      throw new Error('Invalid tracking settings')
    }
    setTrackingSettings(db, { autoStart: settings.autoStart, autoFinish: settings.autoFinish })
    trackingController.setAutoFinish(settings.autoFinish)
  })

  ipcMain.handle(IpcChannels.settingsGetGsx, () => getGsxSettings(db))

  ipcMain.handle(IpcChannels.settingsSetGsx, (_event, settings: GsxSettings) => setGsxSettings(db, settings))

  ipcMain.handle(IpcChannels.settingsCheckGsxFirstLaunch, () => checkGsxFirstLaunch(db))

  // First-launch setup (winglog-backend's docs/plans/first-launch-setup.md).
  ipcMain.handle(IpcChannels.setupGetState, () => getSetupState(db))

  ipcMain.handle(IpcChannels.setupGetContext, () => getSetupContext())

  ipcMain.handle(IpcChannels.setupComplete, () => setSetupCompleted(db))

  ipcMain.handle(IpcChannels.settingsGetUpdates, () => getUpdateSettings(db))

  ipcMain.handle(IpcChannels.settingsSetUpdates, (_event, settings: unknown) => {
    const checkEnabled = (settings as UpdateSettings | null)?.checkEnabled
    if (typeof checkEnabled !== 'boolean') throw new Error('Invalid update settings')
    setUpdateSettings(db, { checkEnabled })
  })
}
