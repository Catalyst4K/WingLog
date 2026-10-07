/** The Settings tab. */

import { useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type {
  AircraftImportSummary,
  AltitudeUnit,
  AppLanguage,
  BeyondAtcConnectionStatus,
  BeyondAtcSettings,
  DataFormat,
  GsxRemoteConnectionStatus,
  GsxRemoteSettings,
  GsxSettings,
  LandingDistanceUnit,
  LogbookImportSummary,
  MapLanguage,
  SyncStatus,
  Theme,
  WeightUnit,
  WindSpeedUnit
} from '@shared/ipc'
import { SegmentedRow, TrackingFields, UnitsFields } from './SettingsFields'
import { trackingLabels } from './trackingLabels'
import { UpdatesCard } from './UpdatesCard'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useResetSignal } from './hooks/useResetSignal'
import { NavigraphLogo } from './NavigraphLogo'
import { asyncHandler, runAsync } from './report-error'

type SettingsCategory = 'ui' | 'thirdParty' | 'data' | 'about'
const DEFAULT_SETTINGS_CATEGORY: SettingsCategory = 'ui'

function settingsCategories(t: TFunction): { value: SettingsCategory; label: string }[] {
  return [
    { value: 'ui', label: t('settingsView.categories.ui') },
    { value: 'thirdParty', label: t('settingsView.categories.thirdParty') },
    { value: 'data', label: t('settingsView.categories.data') },
    { value: 'about', label: t('settingsView.categories.about') }
  ]
}

// A curated, common-currency subset of what frankfurter.dev supports — enough for
// "I want to see this in my own currency" without a second fetch just to populate a
// dropdown (the currency list itself barely ever changes).
function displayCurrencyOptions(t: TFunction): { code: string; label: string }[] {
  return [
    { code: 'USD', label: t('settingsView.currencyOptions.usd') },
    { code: 'GBP', label: t('settingsView.currencyOptions.gbp') },
    { code: 'EUR', label: t('settingsView.currencyOptions.eur') },
    { code: 'CAD', label: t('settingsView.currencyOptions.cad') },
    { code: 'AUD', label: t('settingsView.currencyOptions.aud') },
    { code: 'NZD', label: t('settingsView.currencyOptions.nzd') },
    { code: 'JPY', label: t('settingsView.currencyOptions.jpy') },
    { code: 'CHF', label: t('settingsView.currencyOptions.chf') }
  ]
}

const DATA_FORMATS = [
  { value: 'csv', label: 'CSV' },
  { value: 'json', label: 'JSON' }
] as const

/**
 * One Import/Export pair with its own format picker — Fleet and Logbook each get one
 * (winglog-backend docs/plans/data-export-import.md).
 *
 * @param props The section's title and hint, the file format, and the import and export handlers.
 * @returns The element.
 */
function DataSection(props: {
  title: string
  hint: string
  format: DataFormat
  onFormatChange: (format: DataFormat) => void
  importing: boolean
  onImport: () => void
  onExport: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <section
      aria-label={t('settingsView.data.regionLabel', { title: props.title })}
      className="flex flex-col gap-2"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-foreground">{props.title}</span>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={props.onImport}
            disabled={props.importing}
          >
            {props.importing ? t('settingsView.data.importing') : t('settingsView.data.import')}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={props.onExport}>
            {t('settingsView.data.export')}
          </Button>
        </div>
      </div>
      <SegmentedRow
        label={t('settingsView.data.fileFormat')}
        value={props.format}
        options={DATA_FORMATS}
        onChange={props.onFormatChange}
      />
      <p className="text-xs text-muted-foreground">{props.hint}</p>
    </section>
  )
}

function summarizeAircraftImport(summary: AircraftImportSummary, t: TFunction): string {
  const imported = t('settingsView.data.aircraftImported', { count: summary.imported })
  if (summary.skipped.length === 0) return imported
  const skipped = summary.skipped.map((s) => `${s.registration} (${s.reason})`).join(', ')
  return t('settingsView.data.aircraftImportedWithSkipped', {
    imported,
    count: summary.skipped.length,
    skipped
  })
}

function summarizeLogbookImport(summary: LogbookImportSummary, t: TFunction): string {
  let result = t('settingsView.data.flightsImported', { count: summary.imported })
  if (summary.aircraftCreated > 0) {
    result += t('settingsView.data.aircraftAddedSuffix', { count: summary.aircraftCreated })
  }
  result += '.'
  if (summary.skipped.length > 0) {
    const skipped = summary.skipped.map((s) => `${s.label} (${s.reason})`).join(', ')
    result += ' ' + t('settingsView.data.skippedSuffix', { count: summary.skipped.length, skipped })
  }
  return result
}

/**
 * The Settings tab.
 *
 * @param props Each app-wide setting and its change handler.
 * @returns The element.
 */
export function SettingsView(props: {
  weightUnit: WeightUnit
  onWeightUnitChange: (unit: WeightUnit) => void
  altitudeUnit: AltitudeUnit
  onAltitudeUnitChange: (unit: AltitudeUnit) => void
  windSpeedUnit: WindSpeedUnit
  onWindSpeedUnitChange: (unit: WindSpeedUnit) => void
  landingDistanceUnit: LandingDistanceUnit
  onLandingDistanceUnitChange: (unit: LandingDistanceUnit) => void
  mapLanguage: MapLanguage
  onMapLanguageChange: (language: MapLanguage) => void
  appLanguage: AppLanguage
  onAppLanguageChange: (language: AppLanguage) => void
  theme: Theme
  onThemeChange: (theme: Theme) => void
  /** Mirrors this toggle's live value up to App.tsx, which gates the GSX Remote Control tab
   *  on it (Callum, 2026-09-27) — App.tsx doesn't otherwise see this card's own settings
   *  state, which lives entirely in this component. */
  onGsxRemoteEnabledChange: (enabled: boolean) => void
  /** Same reasoning as onGsxRemoteEnabledChange, for the BeyondATC tab. */
  onBeyondAtcEnabledChange: (enabled: boolean) => void
  /** Settings → About → "Run setup again" reopens the first-launch setup. */
  onRunSetup?: () => void
  /** Bumped by App.tsx when the Settings tab is clicked while already active — returns to
   *  the first category (docs/plans/navigation-tab-behaviour.md). See useResetSignal. */
  resetSignal?: number
}): React.JSX.Element {
  const { t } = useTranslation()
  const [simbriefUsername, setSimbriefUsername] = useState('')
  const [simbriefLoggedIn, setSimbriefLoggedIn] = useState<boolean | null>(null)
  const [loggingIn, setLoggingIn] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const [importingAircraft, setImportingAircraft] = useState(false)
  const [importingLogbook, setImportingLogbook] = useState(false)
  const [fleetFormat, setFleetFormat] = useState<DataFormat>('json')
  const [logbookFormat, setLogbookFormat] = useState<DataFormat>('csv')
  const [gsx, setGsx] = useState<GsxSettings>({ enabled: false, folderPath: null, displayCurrency: 'USD' })
  const [gsxRemote, setGsxRemote] = useState<GsxRemoteSettings>({
    enabled: false,
    host: 'localhost',
    port: null
  })
  // Free-typed while editing — kept separate from gsxRemote.port (number | null) so an
  // in-progress edit (e.g. a momentarily empty field) never round-trips through Number()
  // and silently becomes 0.
  const [gsxRemotePortInput, setGsxRemotePortInput] = useState('')
  const [gsxRemoteStatus, setGsxRemoteStatus] = useState<GsxRemoteConnectionStatus>({
    state: 'disconnected',
    lastError: null
  })
  const [beyondAtc, setBeyondAtc] = useState<BeyondAtcSettings>({ enabled: false, host: 'localhost' })
  const [beyondAtcStatus, setBeyondAtcStatus] = useState<BeyondAtcConnectionStatus>({
    state: 'disconnected',
    lastError: null
  })
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({
    loggedIn: false,
    email: null,
    syncing: false,
    lastSyncedAt: null,
    lastError: null
  })
  const [cloudEmail, setCloudEmail] = useState('')
  const [cloudPassword, setCloudPassword] = useState('')
  const [cloudInviteCode, setCloudInviteCode] = useState('')
  const [cloudAuthMode, setCloudAuthMode] = useState<'login' | 'signup'>('login')
  const [loggingIntoCloud, setLoggingIntoCloud] = useState(false)
  const [appVersion, setAppVersion] = useState('')
  // Purely transient UI state, not persisted — this app has no routing beyond the top tab
  // bar, no reason to add any for a sub-navigation within one of its pages.
  const [category, setCategory] = useState<SettingsCategory>(DEFAULT_SETTINGS_CATEGORY)
  useResetSignal(props.resetSignal, () => setCategory(DEFAULT_SETTINGS_CATEGORY))

  // Destructured so the mount effect below can list them as real dependencies (eslint's
  // exhaustive-deps) instead of reaching into `props` directly, which it can't track.
  const { onGsxRemoteEnabledChange, onBeyondAtcEnabledChange } = props

  useEffect(() => {
    runAsync(
      'SettingsView settingsGetSimbriefUsername',
      window.winglog.settingsGetSimbriefUsername().then((u) => setSimbriefUsername(u ?? ''))
    )
    runAsync(
      'SettingsView dispatchSimbriefLoginStatus',
      window.winglog.dispatchSimbriefLoginStatus().then(setSimbriefLoggedIn)
    )
    runAsync('SettingsView settingsGetGsx', window.winglog.settingsGetGsx().then(setGsx))
    runAsync(
      'SettingsView settingsGetGsxRemote',
      window.winglog.settingsGetGsxRemote().then((settings) => {
        setGsxRemote(settings)
        setGsxRemotePortInput(settings.port != null ? String(settings.port) : '')
        onGsxRemoteEnabledChange(settings.enabled)
      })
    )
    runAsync('SettingsView gsxRemoteGetStatus', window.winglog.gsxRemoteGetStatus().then(setGsxRemoteStatus))
    runAsync(
      'SettingsView settingsGetBeyondAtc',
      window.winglog.settingsGetBeyondAtc().then((settings) => {
        setBeyondAtc(settings)
        onBeyondAtcEnabledChange(settings.enabled)
      })
    )
    runAsync('SettingsView beyondAtcGetStatus', window.winglog.beyondAtcGetStatus().then(setBeyondAtcStatus))
    // Cloud sync build-time flag (docs/plans/public-release-v1.md) — the syncStatus channel
    // doesn't exist at all in a public build, so calling it would just reject.
    /* v8 ignore start -- vitest.config.ts's `define` fixes this flag at `true` for the whole
     * test run (a single run can't hold both literal build values at once), so the "public
     * build, skip this call" arm can't be exercised here; the real cloud-sync-disabled
     * behavior is what public-release-v1.md's own build verifies, not a unit test's job. */
    if (__WINGLOG_CLOUD_SYNC_ENABLED__)
      runAsync('SettingsView syncStatus', window.winglog.syncStatus().then(setSyncStatus))
    /* v8 ignore stop */
    runAsync('SettingsView appGetVersion', window.winglog.appGetVersion().then(setAppVersion))
  }, [onGsxRemoteEnabledChange, onBeyondAtcEnabledChange])

  useEffect(() => {
    return window.winglog.onGsxRemoteStatus(setGsxRemoteStatus)
  }, [])

  useEffect(() => {
    return window.winglog.onBeyondAtcStatus(setBeyondAtcStatus)
  }, [])

  async function handleGsxToggle(enabled: boolean): Promise<void> {
    const next = { ...gsx, enabled }
    setGsx(next)
    await window.winglog.settingsSetGsx(next)
  }

  async function handleGsxBrowse(): Promise<void> {
    const folderPath = await window.winglog.gsxBrowseFolder()
    if (!folderPath) return
    const next = { ...gsx, folderPath }
    setGsx(next)
    await window.winglog.settingsSetGsx(next)
  }

  async function handleGsxCurrencyChange(displayCurrency: string): Promise<void> {
    const next = { ...gsx, displayCurrency }
    setGsx(next)
    await window.winglog.settingsSetGsx(next)
  }

  async function handleGsxRemoteToggle(enabled: boolean): Promise<void> {
    const next = { ...gsxRemote, enabled }
    setGsxRemote(next)
    props.onGsxRemoteEnabledChange(enabled)
    await window.winglog.settingsSetGsxRemote(next)
  }

  async function handleGsxRemoteHostChange(host: string): Promise<void> {
    const next = { ...gsxRemote, host }
    setGsxRemote(next)
    await window.winglog.settingsSetGsxRemote(next)
  }

  async function commitGsxRemotePort(): Promise<void> {
    const trimmed = gsxRemotePortInput.trim()
    const port = trimmed ? Number(trimmed) : null
    if (port !== null && (!Number.isInteger(port) || port <= 0 || port > 65535)) return
    const next = { ...gsxRemote, port }
    setGsxRemote(next)
    await window.winglog.settingsSetGsxRemote(next)
  }

  async function handleBeyondAtcToggle(enabled: boolean): Promise<void> {
    const next = { ...beyondAtc, enabled }
    setBeyondAtc(next)
    props.onBeyondAtcEnabledChange(enabled)
    await window.winglog.settingsSetBeyondAtc(next)
  }

  async function handleBeyondAtcHostChange(host: string): Promise<void> {
    const next = { ...beyondAtc, host }
    setBeyondAtc(next)
    await window.winglog.settingsSetBeyondAtc(next)
  }

  async function handleSaveSimbriefUsername(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    await window.winglog.settingsSetSimbriefUsername(simbriefUsername.trim())
    toast.success(t('settingsView.usernameSavedToast'))
  }

  async function handleLoginToNavigraph(): Promise<void> {
    setLoggingIn(true)
    try {
      await window.winglog.dispatchLoginSimbrief()
      const loggedIn = await window.winglog.dispatchSimbriefLoginStatus()
      setSimbriefLoggedIn(loggedIn)
      if (loggedIn && !simbriefUsername.trim()) {
        const fetched = await window.winglog.dispatchFetchSimbriefUsername()
        if (fetched) {
          setSimbriefUsername(fetched)
          await window.winglog.settingsSetSimbriefUsername(fetched)
          toast.success(t('settingsView.usernameAutoFilledToast', { username: fetched }))
        }
      }
    } finally {
      setLoggingIn(false)
    }
  }

  async function handleLogoutOfNavigraph(): Promise<void> {
    setLoggingOut(true)
    try {
      await window.winglog.dispatchLogoutSimbrief()
      setSimbriefLoggedIn(false)
    } finally {
      setLoggingOut(false)
    }
  }

  async function handleImportAircraft(): Promise<void> {
    setImportingAircraft(true)
    try {
      const summary = await window.winglog.aircraftImport(fleetFormat)
      if (summary) toast.success(summarizeAircraftImport(summary, t))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setImportingAircraft(false)
    }
  }

  async function handleExportAircraft(): Promise<void> {
    try {
      const saved = await window.winglog.aircraftExport(fleetFormat)
      if (saved) toast.success(t('settingsView.data.fleetExported'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleCloudLogin(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setLoggingIntoCloud(true)
    try {
      const status = await window.winglog.authLogin(cloudEmail.trim(), cloudPassword)
      setSyncStatus(status)
      setCloudPassword('')
      toast.success(t('settingsView.cloudSync.loggedInToast'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setLoggingIntoCloud(false)
    }
  }

  async function handleCloudSignup(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setLoggingIntoCloud(true)
    try {
      const status = await window.winglog.authSignup(cloudEmail.trim(), cloudPassword, cloudInviteCode)
      setSyncStatus(status)
      setCloudPassword('')
      setCloudInviteCode('')
      toast.success(t('settingsView.cloudSync.accountCreatedToast'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setLoggingIntoCloud(false)
    }
  }

  async function handleCloudLogout(): Promise<void> {
    setSyncStatus(await window.winglog.authLogout())
  }

  async function handleSyncNow(): Promise<void> {
    setSyncStatus((current) => ({ ...current, syncing: true }))
    const status = await window.winglog.syncNow()
    setSyncStatus(status)
    if (status.lastError) toast.error(status.lastError)
    else toast.success(t('settingsView.cloudSync.syncedToast'))
  }

  async function handleImportLogbook(): Promise<void> {
    setImportingLogbook(true)
    try {
      const summary =
        logbookFormat === 'csv'
          ? await window.winglog.logbookImportCsv()
          : await window.winglog.logbookImportJson()
      if (summary) toast.success(summarizeLogbookImport(summary, t))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setImportingLogbook(false)
    }
  }

  async function handleExportLogbook(): Promise<void> {
    try {
      const saved = await window.winglog.logbookExport(logbookFormat)
      if (saved) toast.success(t('settingsView.data.logbookExported'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-heading text-2xl font-semibold text-foreground">{t('settingsView.title')}</h1>

      <Tabs
        orientation="vertical"
        value={category}
        onValueChange={(value) => setCategory(value as SettingsCategory)}
        className="items-start gap-6"
      >
        <TabsList variant="line" className="w-40 shrink-0 self-stretch border-r border-border/40 pr-3">
          {settingsCategories(t).map(({ value, label }) => (
            <TabsTrigger key={value} value={value}>
              {label}
              {category === value && (
                <ChevronRight data-testid="settings-active-chevron" className="ml-auto" />
              )}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="ui" className="flex min-w-0 flex-col gap-4">
          <Card className="max-w-2xl">
            <CardHeader>
              <CardTitle>{t('settingsView.units.cardTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <UnitsFields
                weightUnit={props.weightUnit}
                onWeightUnitChange={props.onWeightUnitChange}
                altitudeUnit={props.altitudeUnit}
                onAltitudeUnitChange={props.onAltitudeUnitChange}
                windSpeedUnit={props.windSpeedUnit}
                onWindSpeedUnitChange={props.onWindSpeedUnitChange}
                landingDistanceUnit={props.landingDistanceUnit}
                onLandingDistanceUnitChange={props.onLandingDistanceUnitChange}
                mapLanguage={props.mapLanguage}
                onMapLanguageChange={props.onMapLanguageChange}
                appLanguage={props.appLanguage}
                onAppLanguageChange={props.onAppLanguageChange}
              />
            </CardContent>
          </Card>

          <Card className="max-w-2xl">
            <CardHeader>
              <CardTitle>{t('settingsView.theme.cardTitle')}</CardTitle>
            </CardHeader>
            <CardContent>
              <SegmentedRow
                label={t('settingsView.theme.appearance')}
                value={props.theme}
                options={[
                  { value: 'light', label: t('settingsView.theme.light') },
                  { value: 'dark', label: t('settingsView.theme.dark') },
                  { value: 'system', label: t('settingsView.theme.system') }
                ]}
                onChange={props.onThemeChange}
              />
            </CardContent>
          </Card>

          <Card className="max-w-2xl">
            <CardHeader>
              <CardTitle>{t('settingsView.tracking.cardTitle')}</CardTitle>
              <CardDescription>{t('settingsView.tracking.description', trackingLabels(t))}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <TrackingFields />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="thirdParty" className="min-w-0">
          <div className="flex flex-wrap gap-4">
            <Card className="max-w-sm">
              <CardHeader>
                <CardTitle>{t('settingsView.credentials.cardTitle')}</CardTitle>
                <CardDescription>{t('settingsView.credentials.description')}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <form
                  onSubmit={asyncHandler(
                    'SettingsView handleSaveSimbriefUsername',
                    handleSaveSimbriefUsername
                  )}
                  className="flex items-end gap-2"
                >
                  <Label className="flex flex-1 flex-col items-start gap-1.5">
                    {t('settingsView.credentials.simbriefUsername')}
                    <Input
                      value={simbriefUsername}
                      onChange={(e) => setSimbriefUsername(e.target.value)}
                      placeholder={t('settingsView.credentials.usernamePlaceholder')}
                    />
                  </Label>
                  <Button type="submit" variant="outline" size="sm">
                    {t('settingsView.credentials.save')}
                  </Button>
                </form>
                {simbriefLoggedIn ? (
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <NavigraphLogo className="size-6" />
                      <Badge variant="default">{t('settingsView.credentials.loggedIn')}</Badge>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={asyncHandler('SettingsView handleLogoutOfNavigraph', handleLogoutOfNavigraph)}
                      disabled={loggingOut}
                    >
                      {loggingOut
                        ? t('settingsView.credentials.loggingOut')
                        : t('settingsView.credentials.logOut')}
                    </Button>
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    className="h-auto w-full justify-start gap-3 py-3"
                    onClick={asyncHandler('SettingsView handleLoginToNavigraph', handleLoginToNavigraph)}
                    disabled={loggingIn}
                  >
                    <NavigraphLogo className="size-8" />
                    <span className="text-sm font-medium">
                      {loggingIn
                        ? t('settingsView.credentials.loggingIn')
                        : t('settingsView.credentials.logInWithNavigraph')}
                    </span>
                  </Button>
                )}
              </CardContent>
            </Card>

            <Card className="max-w-sm">
              <CardHeader>
                <CardTitle>{t('settingsView.gsx.cardTitle')}</CardTitle>
                <CardDescription>{t('settingsView.gsx.description')}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-foreground">{t('settingsView.gsx.enabled')}</span>
                  <Button
                    type="button"
                    size="sm"
                    variant={gsx.enabled ? 'default' : 'outline'}
                    onClick={asyncHandler('SettingsView handleGsxToggle', () =>
                      handleGsxToggle(!gsx.enabled)
                    )}
                  >
                    {gsx.enabled ? t('settingsView.gsx.on') : t('settingsView.gsx.off')}
                  </Button>
                </div>
                <Label className="flex flex-col items-start gap-1.5">
                  {t('settingsView.gsx.receiptsFolder')}
                  <div className="flex w-full gap-1.5">
                    <Input
                      type="text"
                      readOnly
                      value={gsx.folderPath ?? ''}
                      placeholder={t('settingsView.gsx.notSet')}
                      className="flex-1"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={asyncHandler('SettingsView handleGsxBrowse', handleGsxBrowse)}
                    >
                      {t('settingsView.gsx.browse')}
                    </Button>
                  </div>
                </Label>
                <p className="text-xs text-muted-foreground">{t('settingsView.gsx.pathHint')}</p>
                <Label className="flex flex-col items-start gap-1.5">
                  {t('settingsView.gsx.displayCurrency')}
                  <Select
                    value={gsx.displayCurrency}
                    onValueChange={asyncHandler(
                      'SettingsView handleGsxCurrencyChange',
                      handleGsxCurrencyChange
                    )}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {displayCurrencyOptions(t).map((c) => (
                        <SelectItem key={c.code} value={c.code}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Label>
                <p className="text-xs text-muted-foreground">{t('settingsView.gsx.currencyHint')}</p>
              </CardContent>
            </Card>

            <Card className="max-w-sm">
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-2">
                  {t('settingsView.gsxRemote.cardTitle')}
                  {gsxRemote.enabled && (
                    <Badge
                      variant={
                        gsxRemoteStatus.state === 'connected'
                          ? 'default'
                          : gsxRemoteStatus.state === 'connecting'
                            ? 'secondary'
                            : 'outline'
                      }
                    >
                      {gsxRemoteStatus.state === 'connected'
                        ? t('settingsView.gsxRemote.statusConnected')
                        : gsxRemoteStatus.state === 'connecting'
                          ? t('settingsView.gsxRemote.statusConnecting')
                          : t('settingsView.gsxRemote.statusDisconnected')}
                    </Badge>
                  )}
                </CardTitle>
                <CardDescription>{t('settingsView.gsxRemote.description')}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-foreground">{t('settingsView.gsxRemote.enabled')}</span>
                  <Button
                    type="button"
                    size="sm"
                    variant={gsxRemote.enabled ? 'default' : 'outline'}
                    onClick={asyncHandler('SettingsView handleGsxRemoteToggle', () =>
                      handleGsxRemoteToggle(!gsxRemote.enabled)
                    )}
                  >
                    {gsxRemote.enabled ? t('settingsView.gsxRemote.on') : t('settingsView.gsxRemote.off')}
                  </Button>
                </div>
                <Label className="flex flex-col items-start gap-1.5">
                  {t('settingsView.gsxRemote.host')}
                  <Input
                    type="text"
                    value={gsxRemote.host}
                    onChange={asyncHandler('SettingsView handleGsxRemoteHostChange', (e) =>
                      handleGsxRemoteHostChange(e.target.value)
                    )}
                  />
                </Label>
                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    runAsync('SettingsView commitGsxRemotePort', commitGsxRemotePort())
                  }}
                >
                  <Label className="flex flex-col items-start gap-1.5">
                    {t('settingsView.gsxRemote.port')}
                    <Input
                      type="number"
                      min={1}
                      max={65535}
                      value={gsxRemotePortInput}
                      placeholder={t('settingsView.gsxRemote.portPlaceholder')}
                      onChange={(e) => setGsxRemotePortInput(e.target.value)}
                      onBlur={asyncHandler('SettingsView commitGsxRemotePort', () => commitGsxRemotePort())}
                    />
                  </Label>
                </form>
                <p className="text-xs text-muted-foreground">{t('settingsView.gsxRemote.portHint')}</p>
              </CardContent>
            </Card>

            <Card className="max-w-sm">
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-2">
                  {t('settingsView.beyondAtc.cardTitle')}
                  {beyondAtc.enabled && (
                    <Badge
                      variant={
                        beyondAtcStatus.state === 'connected'
                          ? 'default'
                          : beyondAtcStatus.state === 'connecting'
                            ? 'secondary'
                            : 'outline'
                      }
                    >
                      {beyondAtcStatus.state === 'connected'
                        ? t('settingsView.beyondAtc.statusConnected')
                        : beyondAtcStatus.state === 'connecting'
                          ? t('settingsView.beyondAtc.statusConnecting')
                          : t('settingsView.beyondAtc.statusDisconnected')}
                    </Badge>
                  )}
                </CardTitle>
                <CardDescription>{t('settingsView.beyondAtc.description')}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-foreground">{t('settingsView.beyondAtc.enabled')}</span>
                  <Button
                    type="button"
                    size="sm"
                    variant={beyondAtc.enabled ? 'default' : 'outline'}
                    onClick={asyncHandler('SettingsView handleBeyondAtcToggle', () =>
                      handleBeyondAtcToggle(!beyondAtc.enabled)
                    )}
                  >
                    {beyondAtc.enabled ? t('settingsView.beyondAtc.on') : t('settingsView.beyondAtc.off')}
                  </Button>
                </div>
                <Label className="flex flex-col items-start gap-1.5">
                  {t('settingsView.beyondAtc.host')}
                  <Input
                    type="text"
                    value={beyondAtc.host}
                    onChange={asyncHandler('SettingsView handleBeyondAtcHostChange', (e) =>
                      handleBeyondAtcHostChange(e.target.value)
                    )}
                  />
                </Label>
                <p className="text-xs text-muted-foreground">{t('settingsView.beyondAtc.hostHint')}</p>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="data" className="min-w-0">
          <div className="flex flex-wrap gap-4">
            <Card className="max-w-sm">
              <CardHeader>
                <CardTitle>{t('settingsView.data.cardTitle')}</CardTitle>
                <CardDescription>{t('settingsView.data.description')}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <DataSection
                  title={t('settingsView.data.fleetTitle')}
                  hint={t('settingsView.data.fleetHint')}
                  format={fleetFormat}
                  onFormatChange={setFleetFormat}
                  importing={importingAircraft}
                  onImport={asyncHandler('SettingsView handleImportAircraft', handleImportAircraft)}
                  onExport={asyncHandler('SettingsView handleExportAircraft', handleExportAircraft)}
                />
                <DataSection
                  title={t('settingsView.data.logbookTitle')}
                  hint={t('settingsView.data.logbookHint')}
                  format={logbookFormat}
                  onFormatChange={setLogbookFormat}
                  importing={importingLogbook}
                  onImport={asyncHandler('SettingsView handleImportLogbook', handleImportLogbook)}
                  onExport={asyncHandler('SettingsView handleExportLogbook', handleExportLogbook)}
                />
              </CardContent>
            </Card>

            {/* Cloud sync build-time flag (docs/plans/public-release-v1.md, Decision 1) —
                hidden entirely in a public build, not just disabled: the syncLogin/etc.
                channels this card calls don't exist there at all (see index.ts). */}
            {/* v8 ignore next -- see the matching ignore on this flag's other call site above:
                vitest.config.ts's `define` fixes it at `true`, so the "hidden in a public
                build" arm of this && can't be exercised in this test run. */}
            {__WINGLOG_CLOUD_SYNC_ENABLED__ && (
              <Card className="max-w-sm">
                <CardHeader>
                  <CardTitle>{t('settingsView.cloudSync.cardTitle')}</CardTitle>
                  <CardDescription>{t('settingsView.cloudSync.description')}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  {syncStatus.loggedIn ? (
                    <>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm text-foreground">{syncStatus.email}</span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={asyncHandler('SettingsView handleCloudLogout', handleCloudLogout)}
                        >
                          {t('settingsView.cloudSync.logOut')}
                        </Button>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-xs text-muted-foreground">
                          {syncStatus.lastSyncedAt
                            ? t('settingsView.cloudSync.lastSynced', {
                                date: new Date(syncStatus.lastSyncedAt).toLocaleString()
                              })
                            : t('settingsView.cloudSync.neverSyncedYet')}
                        </p>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={asyncHandler('SettingsView handleSyncNow', handleSyncNow)}
                          disabled={syncStatus.syncing}
                        >
                          {syncStatus.syncing
                            ? t('settingsView.cloudSync.syncing')
                            : t('settingsView.cloudSync.syncNow')}
                        </Button>
                      </div>
                      {syncStatus.lastError && (
                        <p className="text-xs text-destructive">{syncStatus.lastError}</p>
                      )}
                    </>
                  ) : (
                    <>
                      <div className="flex gap-1 rounded-md bg-muted p-1 text-sm">
                        <button
                          type="button"
                          onClick={() => setCloudAuthMode('login')}
                          className={`flex-1 cursor-pointer rounded-sm py-1 ${cloudAuthMode === 'login' ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground'}`}
                        >
                          {t('settingsView.cloudSync.logIn')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setCloudAuthMode('signup')}
                          className={`flex-1 cursor-pointer rounded-sm py-1 ${cloudAuthMode === 'signup' ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground'}`}
                        >
                          {t('settingsView.cloudSync.signUp')}
                        </button>
                      </div>
                      <form
                        onSubmit={asyncHandler(
                          'SettingsView handleCloudLogin',
                          cloudAuthMode === 'login' ? handleCloudLogin : handleCloudSignup
                        )}
                        className="flex flex-col gap-3"
                      >
                        <Label className="flex flex-col items-start gap-1.5">
                          {t('settingsView.cloudSync.email')}
                          <Input
                            type="email"
                            value={cloudEmail}
                            onChange={(e) => setCloudEmail(e.target.value)}
                            required
                          />
                        </Label>
                        <Label className="flex flex-col items-start gap-1.5">
                          {t('settingsView.cloudSync.password')}
                          <Input
                            type="password"
                            value={cloudPassword}
                            onChange={(e) => setCloudPassword(e.target.value)}
                            minLength={cloudAuthMode === 'signup' ? 12 : undefined}
                            required
                          />
                        </Label>
                        {cloudAuthMode === 'signup' && (
                          <>
                            <p className="text-xs text-muted-foreground">
                              {t('settingsView.cloudSync.atLeast12Chars')}
                            </p>
                            <Label className="flex flex-col items-start gap-1.5">
                              {t('settingsView.cloudSync.inviteCode')}
                              <Input
                                type="password"
                                value={cloudInviteCode}
                                onChange={(e) => setCloudInviteCode(e.target.value)}
                                required
                              />
                            </Label>
                            <p className="text-xs text-muted-foreground">
                              {t('settingsView.cloudSync.signupHint')}
                            </p>
                          </>
                        )}
                        <Button
                          type="submit"
                          variant="outline"
                          size="sm"
                          className="w-fit"
                          disabled={loggingIntoCloud}
                        >
                          {loggingIntoCloud
                            ? cloudAuthMode === 'login'
                              ? t('settingsView.cloudSync.loggingIn')
                              : t('settingsView.cloudSync.signingUp')
                            : cloudAuthMode === 'login'
                              ? t('settingsView.cloudSync.logIn')
                              : t('settingsView.cloudSync.signUp')}
                        </Button>
                      </form>
                    </>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>

        <TabsContent value="about" className="flex min-w-0 flex-col gap-4">
          <Card className="max-w-2xl">
            <CardHeader>
              <CardTitle>WingLog{appVersion ? ` v${appVersion}` : ''}</CardTitle>
              <CardDescription>{t('settingsView.about.description')}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-sm font-medium text-foreground">{t('settingsView.about.simulationOnly')}</p>
              <p className="text-sm text-foreground">{t('settingsView.about.disclaimer')}</p>
              <p className="text-xs text-muted-foreground">
                {t('settingsView.about.license')}{' '}
                <button
                  type="button"
                  onClick={asyncHandler('SettingsView appOpenGithub', () => window.winglog.appOpenGithub())}
                  className="cursor-pointer underline underline-offset-2 hover:text-foreground"
                >
                  github.com/Catalyst4K/WingLog
                </button>
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={asyncHandler('SettingsView appOpenManual', async () => {
                    if (!(await window.winglog.appOpenManual()))
                      toast.error(t('settingsView.about.manualMissing'))
                  })}
                >
                  {t('settingsView.about.openManual')}
                </Button>
                {props.onRunSetup && (
                  <Button type="button" variant="outline" size="sm" onClick={props.onRunSetup}>
                    {t('settingsView.about.runSetup')}
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
          <UpdatesCard />
        </TabsContent>
      </Tabs>
    </div>
  )
}
