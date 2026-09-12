import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type {
  AircraftImportSummary,
  AltitudeUnit,
  GsxSettings,
  LandingDistanceUnit,
  LandingThresholds,
  LogbookImportSummary,
  SyncStatus,
  Theme,
  WeightUnit,
  WindSpeedUnit
} from '@shared/ipc'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useResetSignal } from './hooks/useResetSignal'
import { NavigraphLogo } from './NavigraphLogo'

type SettingsCategory = 'ui' | 'tracking' | 'thirdParty' | 'data' | 'about'
const DEFAULT_SETTINGS_CATEGORY: SettingsCategory = 'ui'

// A curated, common-currency subset of what frankfurter.dev supports — enough for
// "I want to see this in my own currency" without a second fetch just to populate a
// dropdown (the currency list itself barely ever changes).
const DISPLAY_CURRENCY_OPTIONS = [
  { code: 'USD', label: 'USD — US Dollar (no conversion)' },
  { code: 'GBP', label: 'GBP — British Pound' },
  { code: 'EUR', label: 'EUR — Euro' },
  { code: 'CAD', label: 'CAD — Canadian Dollar' },
  { code: 'AUD', label: 'AUD — Australian Dollar' },
  { code: 'NZD', label: 'NZD — New Zealand Dollar' },
  { code: 'JPY', label: 'JPY — Japanese Yen' },
  { code: 'CHF', label: 'CHF — Swiss Franc' }
]

/** Label above an equal-width button group, one row of the UI page's Units/Theme cards
 *  (docs/plans/settings-ui-page.md) — replaces the old label-beside-buttons rows, whose
 *  button groups started at three different x positions depending on label length. Every
 *  button gets the same min-width so a two-option row and a three-option row read as the
 *  same kind of control. */
function SegmentedRow<T extends string>(props: {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm text-muted-foreground">{props.label}</span>
      <div className="flex gap-1.5">
        {props.options.map((opt) => (
          <Button
            key={opt.value}
            type="button"
            size="sm"
            variant={props.value === opt.value ? 'default' : 'outline'}
            className="min-w-[4.5rem]"
            onClick={() => props.onChange(opt.value)}
          >
            {opt.label}
          </Button>
        ))}
      </div>
    </div>
  )
}

function summarizeAircraftImport(summary: AircraftImportSummary): string {
  if (summary.skipped.length === 0) return `Imported ${summary.imported} aircraft.`
  const skipped = summary.skipped.map((s) => `${s.registration} (${s.reason})`).join(', ')
  return `Imported ${summary.imported} aircraft. Skipped ${summary.skipped.length}: ${skipped}`
}

function summarizeLogbookImport(summary: LogbookImportSummary): string {
  const flightsLabel = `${summary.imported} flight${summary.imported === 1 ? '' : 's'}`
  const aircraftLabel =
    summary.aircraftCreated > 0 ? ` (added ${summary.aircraftCreated} aircraft to your fleet)` : ''
  const skippedLabel =
    summary.skipped.length > 0
      ? ` Skipped ${summary.skipped.length}: ${summary.skipped.map((s) => `${s.label} (${s.reason})`).join(', ')}`
      : ''
  return `Imported ${flightsLabel}${aircraftLabel}.${skippedLabel}`
}

export function SettingsView(props: {
  weightUnit: WeightUnit
  onWeightUnitChange: (unit: WeightUnit) => void
  altitudeUnit: AltitudeUnit
  onAltitudeUnitChange: (unit: AltitudeUnit) => void
  windSpeedUnit: WindSpeedUnit
  onWindSpeedUnitChange: (unit: WindSpeedUnit) => void
  landingDistanceUnit: LandingDistanceUnit
  onLandingDistanceUnitChange: (unit: LandingDistanceUnit) => void
  theme: Theme
  onThemeChange: (theme: Theme) => void
  /** Bumped by App.tsx when the Settings tab is clicked while already active — returns to
   *  the first category (docs/plans/navigation-tab-behaviour.md). See useResetSignal. */
  resetSignal?: number
}): React.JSX.Element {
  const [simbriefUsername, setSimbriefUsername] = useState('')
  const [simbriefLoggedIn, setSimbriefLoggedIn] = useState<boolean | null>(null)
  const [loggingIn, setLoggingIn] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const [importingAircraft, setImportingAircraft] = useState(false)
  const [importingLogbook, setImportingLogbook] = useState(false)
  const [gsx, setGsx] = useState<GsxSettings>({ enabled: false, folderPath: null, displayCurrency: 'USD' })
  const [landingThresholds, setLandingThresholds] = useState<LandingThresholds>({
    firmFpm: 480,
    hardFpm: 600
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

  useEffect(() => {
    window.winglog.settingsGetSimbriefUsername().then((u) => setSimbriefUsername(u ?? ''))
    window.winglog.dispatchSimbriefLoginStatus().then(setSimbriefLoggedIn)
    window.winglog.settingsGetGsx().then(setGsx)
    window.winglog.settingsGetLandingThresholds().then(setLandingThresholds)
    // Cloud sync build-time flag (docs/plans/public-release-v1.md) — the syncStatus channel
    // doesn't exist at all in a public build, so calling it would just reject.
    if (__WINGLOG_CLOUD_SYNC_ENABLED__) window.winglog.syncStatus().then(setSyncStatus)
    window.winglog.appGetVersion().then(setAppVersion)
  }, [])

  async function handleSaveLandingThresholds(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    await window.winglog.settingsSetLandingThresholds(landingThresholds)
    toast.success('Landing thresholds saved.')
  }

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

  async function handleSaveSimbriefUsername(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    await window.winglog.settingsSetSimbriefUsername(simbriefUsername.trim())
    toast.success('SimBrief username saved.')
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
          toast.success(`SimBrief username filled in automatically: ${fetched}`)
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
      const summary = await window.winglog.aircraftImport()
      if (summary) toast.success(summarizeAircraftImport(summary))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setImportingAircraft(false)
    }
  }

  async function handleExportAircraft(): Promise<void> {
    try {
      const saved = await window.winglog.aircraftExport()
      if (saved) toast.success('Fleet exported.')
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
      toast.success('Logged in.')
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
      toast.success('Account created and logged in.')
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
    else toast.success('Synced.')
  }

  async function handleImportLogbook(): Promise<void> {
    setImportingLogbook(true)
    try {
      const summary = await window.winglog.logbookImportCsv()
      if (summary) toast.success(summarizeLogbookImport(summary))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setImportingLogbook(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-heading text-2xl font-semibold text-foreground">Settings</h1>

      <Tabs
        orientation="vertical"
        value={category}
        onValueChange={(value) => setCategory(value as SettingsCategory)}
        className="items-start gap-6"
      >
        <TabsList variant="line" className="w-40 shrink-0">
          <TabsTrigger value="ui">UI</TabsTrigger>
          <TabsTrigger value="tracking">Tracking</TabsTrigger>
          <TabsTrigger value="thirdParty">3rd party</TabsTrigger>
          <TabsTrigger value="data">Data</TabsTrigger>
          <TabsTrigger value="about">About</TabsTrigger>
        </TabsList>

        <TabsContent value="ui" className="flex min-w-0 flex-col gap-4">
          <Card className="max-w-2xl">
            <CardHeader>
              <CardTitle>Units</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <SegmentedRow
                label="Weights"
                value={props.weightUnit}
                options={[
                  { value: 'kg', label: 'kg' },
                  { value: 'lb', label: 'lb' }
                ]}
                onChange={props.onWeightUnitChange}
              />
              <div className="flex flex-col gap-1.5">
                <SegmentedRow
                  label="OFP altitudes"
                  value={props.altitudeUnit}
                  options={[
                    { value: 'ft', label: 'Feet' },
                    { value: 'm', label: 'Meters' },
                    { value: 'hybrid', label: 'Hybrid' }
                  ]}
                  onChange={props.onAltitudeUnitChange}
                />
                <p className="text-xs text-muted-foreground">
                  "Hybrid" shows each step climb in whichever unit it was actually planned in — feet for a
                  standard level, meters for a route crossing into airspace (e.g. China) that assigns levels
                  in meters — rather than converting everything to one unit.
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <SegmentedRow
                  label="METAR wind speed"
                  value={props.windSpeedUnit}
                  options={[
                    { value: 'kt', label: 'Knots' },
                    { value: 'mps', label: 'm/s' }
                  ]}
                  onChange={props.onWindSpeedUnitChange}
                />
                <p className="text-xs text-muted-foreground">
                  The raw METAR text on Dispatch always stays as reported — this only controls a separate
                  formatted wind line shown alongside it.
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <SegmentedRow
                  label="Landing distances"
                  value={props.landingDistanceUnit}
                  options={[
                    { value: 'ft', label: 'Feet' },
                    { value: 'm', label: 'Meters' }
                  ]}
                  onChange={props.onLandingDistanceUnitChange}
                />
                <p className="text-xs text-muted-foreground">
                  Distance from threshold and centreline offset on a Logbook flight's landing card, and its
                  touchdown diagram. Touchdown rate stays fpm and speeds/wind stay knots regardless.
                </p>
              </div>
            </CardContent>
          </Card>

          <Card className="max-w-2xl">
            <CardHeader>
              <CardTitle>Theme</CardTitle>
            </CardHeader>
            <CardContent>
              <SegmentedRow
                label="Appearance"
                value={props.theme}
                options={[
                  { value: 'light', label: 'Light' },
                  { value: 'dark', label: 'Dark' },
                  { value: 'system', label: 'System' }
                ]}
                onChange={props.onThemeChange}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="thirdParty" className="min-w-0">
          <div className="flex flex-wrap gap-4">
            <Card className="max-w-sm">
              <CardHeader>
                <CardTitle>Credentials</CardTitle>
                <CardDescription>Used by Dispatch to fetch and generate plans on SimBrief.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <form onSubmit={handleSaveSimbriefUsername} className="flex items-end gap-2">
                  <Label className="flex flex-1 flex-col items-start gap-1.5">
                    SimBrief username
                    <Input
                      value={simbriefUsername}
                      onChange={(e) => setSimbriefUsername(e.target.value)}
                      placeholder="Navigraph Alias"
                    />
                  </Label>
                  <Button type="submit" variant="outline" size="sm">
                    Save
                  </Button>
                </form>
                {simbriefLoggedIn ? (
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <NavigraphLogo className="size-6" />
                      <Badge variant="default">Logged in</Badge>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleLogoutOfNavigraph}
                      disabled={loggingOut}
                    >
                      {loggingOut ? 'Logging out…' : 'Log out'}
                    </Button>
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    className="h-auto w-full justify-start gap-3 py-3"
                    onClick={handleLoginToNavigraph}
                    disabled={loggingIn}
                  >
                    <NavigraphLogo className="size-8" />
                    <span className="text-sm font-medium">
                      {loggingIn ? 'Logging in…' : 'Log in with Navigraph'}
                    </span>
                  </Button>
                )}
              </CardContent>
            </Card>

            <Card className="max-w-sm">
              <CardHeader>
                <CardTitle>GSX ground services</CardTitle>
                <CardDescription>
                  Attach GSX Pro's catering/fuel/handling receipts to matching flights in your Logbook.
                  Windows only (GSX itself is Windows-only) — off by default, and nothing here shows up until
                  enabled.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-foreground">Enabled</span>
                  <Button
                    type="button"
                    size="sm"
                    variant={gsx.enabled ? 'default' : 'outline'}
                    onClick={() => handleGsxToggle(!gsx.enabled)}
                  >
                    {gsx.enabled ? 'On' : 'Off'}
                  </Button>
                </div>
                <Label className="flex flex-col items-start gap-1.5">
                  Receipts folder
                  <div className="flex w-full gap-1.5">
                    <Input
                      type="text"
                      readOnly
                      value={gsx.folderPath ?? ''}
                      placeholder="Not set"
                      className="flex-1"
                    />
                    <Button type="button" variant="outline" size="sm" onClick={handleGsxBrowse}>
                      Browse…
                    </Button>
                  </div>
                </Label>
                <p className="text-xs text-muted-foreground">
                  Usually %APPDATA%\Virtuali\GSX\Receipts. A path that's wrong or no longer exists just means
                  no receipts are found — never an error.
                </p>
                <Label className="flex flex-col items-start gap-1.5">
                  Display currency
                  <Select value={gsx.displayCurrency} onValueChange={handleGsxCurrencyChange}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DISPLAY_CURRENCY_OPTIONS.map((c) => (
                        <SelectItem key={c.code} value={c.code}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Label>
                <p className="text-xs text-muted-foreground">
                  GSX totals convert using a live rate fetched at the time you view them — nothing is stored
                  converted.
                </p>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="tracking" className="min-w-0">
          <Card className="max-w-2xl">
            <CardHeader>
              <CardTitle>Landing severity</CardTitle>
              <CardDescription>
                Touchdown rate thresholds for the firm/hard badges on Fleet and Logbook landing records. Real
                guidance varies by aircraft category — these are general-aviation-leaning defaults, not
                universal.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSaveLandingThresholds} className="flex flex-col gap-3">
                <div className="flex gap-3">
                  <Label className="flex flex-1 flex-col items-start gap-1.5">
                    Firm (fpm)
                    <Input
                      type="number"
                      value={landingThresholds.firmFpm}
                      onChange={(e) =>
                        setLandingThresholds((current) => ({ ...current, firmFpm: Number(e.target.value) }))
                      }
                    />
                  </Label>
                  <Label className="flex flex-1 flex-col items-start gap-1.5">
                    Hard (fpm)
                    <Input
                      type="number"
                      value={landingThresholds.hardFpm}
                      onChange={(e) =>
                        setLandingThresholds((current) => ({ ...current, hardFpm: Number(e.target.value) }))
                      }
                    />
                  </Label>
                </div>
                <Button type="submit" variant="outline" size="sm" className="w-fit">
                  Save
                </Button>
              </form>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="data" className="min-w-0">
          <div className="flex flex-wrap gap-4">
            <Card className="max-w-sm">
              <CardHeader>
                <CardTitle>Data</CardTitle>
                <CardDescription>Import or export your fleet and logbook as local files.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-foreground">Fleet (JSON)</span>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleImportAircraft}
                      disabled={importingAircraft}
                    >
                      {importingAircraft ? 'Importing…' : 'Import'}
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={handleExportAircraft}>
                      Export
                    </Button>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-foreground">Logbook (CSV)</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleImportLogbook}
                    disabled={importingLogbook}
                  >
                    {importingLogbook ? 'Importing…' : 'Import'}
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Cloud sync build-time flag (docs/plans/public-release-v1.md, Decision 1) —
                hidden entirely in a public build, not just disabled: the syncLogin/etc.
                channels this card calls don't exist there at all (see index.ts). */}
            {__WINGLOG_CLOUD_SYNC_ENABLED__ && (
            <Card className="max-w-sm">
              <CardHeader>
                <CardTitle>Cloud sync</CardTitle>
                <CardDescription>
                  Sync Fleet and Logbook across your machines. This is WingLog's own service, not a
                  third party — off by default, nothing leaves this device until you log in.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {syncStatus.loggedIn ? (
                  <>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm text-foreground">{syncStatus.email}</span>
                      <Button type="button" variant="outline" size="sm" onClick={handleCloudLogout}>
                        Log out
                      </Button>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs text-muted-foreground">
                        {syncStatus.lastSyncedAt
                          ? `Last synced ${new Date(syncStatus.lastSyncedAt).toLocaleString()}`
                          : 'Never synced yet.'}
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleSyncNow}
                        disabled={syncStatus.syncing}
                      >
                        {syncStatus.syncing ? 'Syncing…' : 'Sync now'}
                      </Button>
                    </div>
                    {syncStatus.lastError && <p className="text-xs text-destructive">{syncStatus.lastError}</p>}
                  </>
                ) : (
                  <>
                    <div className="flex gap-1 rounded-md bg-muted p-1 text-sm">
                      <button
                        type="button"
                        onClick={() => setCloudAuthMode('login')}
                        className={`flex-1 cursor-pointer rounded-sm py-1 ${cloudAuthMode === 'login' ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground'}`}
                      >
                        Log in
                      </button>
                      <button
                        type="button"
                        onClick={() => setCloudAuthMode('signup')}
                        className={`flex-1 cursor-pointer rounded-sm py-1 ${cloudAuthMode === 'signup' ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground'}`}
                      >
                        Sign up
                      </button>
                    </div>
                    <form
                      onSubmit={cloudAuthMode === 'login' ? handleCloudLogin : handleCloudSignup}
                      className="flex flex-col gap-3"
                    >
                      <Label className="flex flex-col items-start gap-1.5">
                        Email
                        <Input
                          type="email"
                          value={cloudEmail}
                          onChange={(e) => setCloudEmail(e.target.value)}
                          required
                        />
                      </Label>
                      <Label className="flex flex-col items-start gap-1.5">
                        Password
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
                          <p className="text-xs text-muted-foreground">At least 12 characters.</p>
                          <Label className="flex flex-col items-start gap-1.5">
                            Invite code
                            <Input
                              type="password"
                              value={cloudInviteCode}
                              onChange={(e) => setCloudInviteCode(e.target.value)}
                              required
                            />
                          </Label>
                          <p className="text-xs text-muted-foreground">
                            Signup isn't public yet — this only works with an invite code from the app owner.
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
                            ? 'Logging in…'
                            : 'Signing up…'
                          : cloudAuthMode === 'login'
                            ? 'Log in'
                            : 'Sign up'}
                      </Button>
                    </form>
                  </>
                )}
              </CardContent>
            </Card>
            )}
          </div>
        </TabsContent>

        <TabsContent value="about" className="min-w-0">
          <Card className="max-w-2xl">
            <CardHeader>
              <CardTitle>WingLog{appVersion ? ` v${appVersion}` : ''}</CardTitle>
              <CardDescription>
                A personal fleet-management, dispatch, live-tracking and logbook companion for Microsoft
                Flight Simulator.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-sm text-foreground">
                WingLog is not affiliated with, endorsed by, or sponsored by Microsoft Corporation or Asobo
                Studio. "Microsoft Flight Simulator" is a trademark of its respective owners.
              </p>
              <p className="text-xs text-muted-foreground">
                Free and open source under the GNU General Public License v3.0.{' '}
                <button
                  type="button"
                  onClick={() => window.winglog.appOpenGithub()}
                  className="cursor-pointer underline underline-offset-2 hover:text-foreground"
                >
                  github.com/Catalyst4K/WingLog
                </button>
              </p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
