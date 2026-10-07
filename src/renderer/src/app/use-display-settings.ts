/** The persisted display settings the app shell loads once and threads to every view. */

import { useEffect, useState } from 'react'
import type {
  AltitudeUnit,
  AppLanguage,
  LandingDistanceUnit,
  MapLanguage,
  Theme,
  WeightUnit,
  WindSpeedUnit
} from '@shared/ipc'
import { resolveAppLanguage } from '@shared/app-language'
import i18n from '../i18n'
import { runAsync } from '../report-error'

/** The persisted display settings, and the handlers that change and save them. */
export interface DisplaySettings {
  weightUnit: WeightUnit
  altitudeUnit: AltitudeUnit
  windSpeedUnit: WindSpeedUnit
  mapLanguage: MapLanguage
  appLanguage: AppLanguage
  landingDistanceUnit: LandingDistanceUnit
  theme: Theme
  /** Gates the GSX Remote Control tab — hidden until its settings load, then tracks live
   *  toggles from Settings, so the tab appears or disappears immediately rather than only
   *  after the next app restart. */
  gsxRemoteEnabled: boolean
  setGsxRemoteEnabled: (enabled: boolean) => void
  /** Gates the BeyondATC tab, the same way. */
  beyondAtcEnabled: boolean
  setBeyondAtcEnabled: (enabled: boolean) => void
  onWeightUnitChange: (unit: WeightUnit) => Promise<void>
  onAltitudeUnitChange: (unit: AltitudeUnit) => Promise<void>
  onWindSpeedUnitChange: (unit: WindSpeedUnit) => Promise<void>
  onLandingDistanceUnitChange: (unit: LandingDistanceUnit) => Promise<void>
  onMapLanguageChange: (language: MapLanguage) => Promise<void>
  onAppLanguageChange: (language: AppLanguage) => Promise<void>
  onThemeChange: (theme: Theme) => Promise<void>
}

/**
 * Loads the display settings once on mount, applies the theme, and saves each change.
 *
 * @returns The settings and their change handlers.
 */
export function useDisplaySettings(): DisplaySettings {
  const [weightUnit, setWeightUnit] = useState<WeightUnit>('lb')
  const [altitudeUnit, setAltitudeUnit] = useState<AltitudeUnit>('ft')
  const [windSpeedUnit, setWindSpeedUnit] = useState<WindSpeedUnit>('kt')
  const [mapLanguage, setMapLanguage] = useState<MapLanguage>('en')
  const [appLanguage, setAppLanguage] = useState<AppLanguage>('system')
  const [landingDistanceUnit, setLandingDistanceUnit] = useState<LandingDistanceUnit>('ft')
  const [theme, setTheme] = useState<Theme>('system')
  const [gsxRemoteEnabled, setGsxRemoteEnabled] = useState(false)
  const [beyondAtcEnabled, setBeyondAtcEnabled] = useState(false)

  useEffect(() => {
    runAsync('App settingsGetWeightUnit', window.winglog.settingsGetWeightUnit().then(setWeightUnit))
    runAsync('App settingsGetAltitudeUnit', window.winglog.settingsGetAltitudeUnit().then(setAltitudeUnit))
    runAsync('App settingsGetWindSpeedUnit', window.winglog.settingsGetWindSpeedUnit().then(setWindSpeedUnit))
    runAsync('App settingsGetMapLanguage', window.winglog.settingsGetMapLanguage().then(setMapLanguage))
    runAsync(
      'App settingsGetLandingDistanceUnit',
      window.winglog.settingsGetLandingDistanceUnit().then(setLandingDistanceUnit)
    )
    runAsync('App settingsGetTheme', window.winglog.settingsGetTheme().then(setTheme))
    runAsync(
      'App settingsGetGsxRemote',
      window.winglog.settingsGetGsxRemote().then((settings) => setGsxRemoteEnabled(settings.enabled))
    )
    runAsync(
      'App settingsGetBeyondAtc',
      window.winglog.settingsGetBeyondAtc().then((settings) => setBeyondAtcEnabled(settings.enabled))
    )
    runAsync(
      'App settingsGetAppLanguage',
      Promise.all([window.winglog.settingsGetAppLanguage(), window.winglog.settingsGetSystemLocale()]).then(
        ([saved, systemLocale]) => {
          setAppLanguage(saved)
          void i18n.changeLanguage(resolveAppLanguage(saved, systemLocale))
        }
      )
    )
  }, [])

  // Applies the resolved theme by toggling the `dark` class index.css's tokens key off
  // (docs/plans/settings-ui-page.md) — both palettes already existed as dead CSS before
  // this, nothing ever added the class. 'system' resolves via prefers-color-scheme and
  // keeps listening, so the app follows an OS appearance change made while it's open.
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    function applyResolvedTheme(): void {
      const dark = theme === 'dark' || (theme === 'system' && media.matches)
      document.documentElement.classList.toggle('dark', dark)
    }
    applyResolvedTheme()
    if (theme !== 'system') return
    media.addEventListener('change', applyResolvedTheme)
    return () => media.removeEventListener('change', applyResolvedTheme)
  }, [theme])

  return {
    weightUnit,
    altitudeUnit,
    windSpeedUnit,
    mapLanguage,
    appLanguage,
    landingDistanceUnit,
    theme,
    gsxRemoteEnabled,
    setGsxRemoteEnabled,
    beyondAtcEnabled,
    setBeyondAtcEnabled,
    onWeightUnitChange: async (unit) => {
      setWeightUnit(unit)
      await window.winglog.settingsSetWeightUnit(unit)
    },
    onAltitudeUnitChange: async (unit) => {
      setAltitudeUnit(unit)
      await window.winglog.settingsSetAltitudeUnit(unit)
    },
    onWindSpeedUnitChange: async (unit) => {
      setWindSpeedUnit(unit)
      await window.winglog.settingsSetWindSpeedUnit(unit)
    },
    onLandingDistanceUnitChange: async (unit) => {
      setLandingDistanceUnit(unit)
      await window.winglog.settingsSetLandingDistanceUnit(unit)
    },
    onMapLanguageChange: async (language) => {
      setMapLanguage(language)
      await window.winglog.settingsSetMapLanguage(language)
    },
    onAppLanguageChange: async (language) => {
      setAppLanguage(language)
      await window.winglog.settingsSetAppLanguage(language)
      const systemLocale = await window.winglog.settingsGetSystemLocale()
      void i18n.changeLanguage(resolveAppLanguage(language, systemLocale))
    },
    onThemeChange: async (next) => {
      setTheme(next)
      await window.winglog.settingsSetTheme(next)
    }
  }
}
