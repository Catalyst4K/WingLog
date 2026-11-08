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
  type UpdateSettings,
  type WindowSettings,
  type WindowSettingsPatch
} from '@shared/ipc'
import type { WingLogDb } from '../db/client'
import type { TrackingController } from '../tracking/TrackingController'
import type { TrayController } from '../window/TrayController'
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
  setUpdateSettings,
  getMinimizeToTray,
  setMinimizeToTray,
  getHostOnly,
  setHostOnly,
  getStartWithWindows,
  setStartWithWindows
} from '../db/settings-repo'
import { setMainLanguage } from '../i18n'
import { checkGsxFirstLaunch } from '../db/gsx-first-launch'
import { getSetupState, getSetupContext, setSetupCompleted } from '../setup/first-run'

/**
 * @param settings What the renderer sent for the window settings.
 * @returns The booleans it set, and nothing else.
 * @throws When it is not an object with at least one of them, or one is not a boolean.
 */
function windowPatch(settings: unknown): WindowSettingsPatch {
  if (typeof settings !== 'object' || settings === null) throw new Error('Invalid window settings')
  const patch: WindowSettingsPatch = {}
  for (const key of ['minimizeToTray', 'hostOnly', 'startWithWindows'] as const) {
    const value = (settings as Record<string, unknown>)[key]
    if (value === undefined) continue
    if (typeof value !== 'boolean') throw new Error('Invalid window settings')
    patch[key] = value
  }
  if (Object.keys(patch).length === 0) throw new Error('Invalid window settings')
  return patch
}

/** What the settings channels need. */
export interface SettingsHandlerDeps {
  db: WingLogDb
  /** Takes "Finish flights automatically" as soon as it changes. */
  trackingController: Pick<TrackingController, 'setAutoFinish'>
  /** The tray icon follows the "minimise to the tray" setting as soon as it changes. */
  trayController: Pick<TrayController, 'sync' | 'isAvailable'>
  /** The window's edge takes the new theme's colour as soon as the theme changes. */
  onThemeChanged?: () => void
  /** What running in the background and starting with Windows need from this computer; left out, neither is offered. */
  background?: {
    /** Whether "run in the background" is offered (a multi-device build, the sim PC's host, a tray). */
    available: boolean
    /** Whether "start with Windows" is offered (an installed copy). */
    loginItemAvailable: boolean
    /** Adds WingLog to, or removes it from, what starts at sign-in. */
    setLoginItem: (open: boolean) => void
  }
}

/**
 * Registers the settings and setup channels.
 *
 * @param ipcMain Electron's IPC.
 * @param deps The database, and the tracking controller for auto-finish.
 */
export function registerSettingsHandlers(
  ipcMain: IpcMain,
  { db, trackingController, trayController, onThemeChanged, background }: SettingsHandlerDeps
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

  ipcMain.handle(IpcChannels.settingsSetTheme, (_event, theme: Theme) => {
    setTheme(db, theme)
    onThemeChanged?.()
  })

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

  ipcMain.handle(IpcChannels.settingsGetWindow, (): WindowSettings => ({
    minimizeToTray: getMinimizeToTray(db),
    trayAvailable: trayController.isAvailable,
    hostOnly: getHostOnly(db),
    backgroundAvailable: background?.available === true,
    startWithWindows: getStartWithWindows(db),
    startWithWindowsAvailable: background?.loginItemAvailable === true
  }))

  ipcMain.handle(IpcChannels.settingsSetWindow, (_event, settings: unknown) => {
    const patch = windowPatch(settings)
    if (patch.minimizeToTray !== undefined) setMinimizeToTray(db, patch.minimizeToTray)
    if (patch.hostOnly !== undefined) setHostOnly(db, patch.hostOnly)
    if (patch.startWithWindows !== undefined) {
      setStartWithWindows(db, patch.startWithWindows)
      background?.setLoginItem(patch.startWithWindows)
    }
    trayController.sync()
  })
}
