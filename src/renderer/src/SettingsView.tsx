import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type {
  AircraftImportSummary,
  AltitudeUnit,
  GsxSettings,
  LandingThresholds,
  LogbookImportSummary,
  SyncStatus,
  WeightUnit
} from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

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
}): React.JSX.Element {
  const [simbriefUsername, setSimbriefUsername] = useState('')
  const [loggingIn, setLoggingIn] = useState(false)
  const [importingAircraft, setImportingAircraft] = useState(false)
  const [importingLogbook, setImportingLogbook] = useState(false)
  const [gsx, setGsx] = useState<GsxSettings>({ enabled: false, folderPath: null, displayCurrency: 'USD' })
  const [landingThresholds, setLandingThresholds] = useState<LandingThresholds>({ firmFpm: 480, hardFpm: 600 })
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({
    loggedIn: false,
    email: null,
    syncing: false,
    lastSyncedAt: null,
    lastError: null
  })
  const [cloudEmail, setCloudEmail] = useState('')
  const [cloudPassword, setCloudPassword] = useState('')
  const [loggingIntoCloud, setLoggingIntoCloud] = useState(false)

  useEffect(() => {
    window.flightdeck.settingsGetSimbriefUsername().then((u) => setSimbriefUsername(u ?? ''))
    window.flightdeck.settingsGetGsx().then(setGsx)
    window.flightdeck.settingsGetLandingThresholds().then(setLandingThresholds)
    window.flightdeck.syncStatus().then(setSyncStatus)
  }, [])

  async function handleSaveLandingThresholds(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    await window.flightdeck.settingsSetLandingThresholds(landingThresholds)
    toast.success('Landing thresholds saved.')
  }

  async function handleGsxToggle(enabled: boolean): Promise<void> {
    const next = { ...gsx, enabled }
    setGsx(next)
    await window.flightdeck.settingsSetGsx(next)
  }

  async function handleGsxBrowse(): Promise<void> {
    const folderPath = await window.flightdeck.gsxBrowseFolder()
    if (!folderPath) return
    const next = { ...gsx, folderPath }
    setGsx(next)
    await window.flightdeck.settingsSetGsx(next)
  }

  async function handleGsxCurrencyChange(displayCurrency: string): Promise<void> {
    const next = { ...gsx, displayCurrency }
    setGsx(next)
    await window.flightdeck.settingsSetGsx(next)
  }

  async function handleSaveSimbriefUsername(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    await window.flightdeck.settingsSetSimbriefUsername(simbriefUsername.trim())
    toast.success('SimBrief username saved.')
  }

  async function handleLoginToNavigraph(): Promise<void> {
    setLoggingIn(true)
    try {
      await window.flightdeck.dispatchLoginSimbrief()
    } finally {
      setLoggingIn(false)
    }
  }

  async function handleImportAircraft(): Promise<void> {
    setImportingAircraft(true)
    try {
      const summary = await window.flightdeck.aircraftImport()
      if (summary) toast.success(summarizeAircraftImport(summary))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setImportingAircraft(false)
    }
  }

  async function handleExportAircraft(): Promise<void> {
    try {
      const saved = await window.flightdeck.aircraftExport()
      if (saved) toast.success('Fleet exported.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleCloudLogin(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setLoggingIntoCloud(true)
    try {
      const status = await window.flightdeck.authLogin(cloudEmail.trim(), cloudPassword)
      setSyncStatus(status)
      setCloudPassword('')
      toast.success('Logged in.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setLoggingIntoCloud(false)
    }
  }

  async function handleCloudLogout(): Promise<void> {
    setSyncStatus(await window.flightdeck.authLogout())
  }

  async function handleSyncNow(): Promise<void> {
    setSyncStatus((current) => ({ ...current, syncing: true }))
    const status = await window.flightdeck.syncNow()
    setSyncStatus(status)
    if (status.lastError) toast.error(status.lastError)
    else toast.success('Synced.')
  }

  async function handleImportLogbook(): Promise<void> {
    setImportingLogbook(true)
    try {
      const summary = await window.flightdeck.logbookImportCsv()
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

      <Card className="max-w-sm">
        <CardHeader>
          <CardTitle>Units</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">Weights:</span>
            <div className="flex gap-1.5">
              {(['kg', 'lb'] as const).map((unit) => (
                <Button
                  key={unit}
                  type="button"
                  size="sm"
                  variant={props.weightUnit === unit ? 'default' : 'outline'}
                  onClick={() => props.onWeightUnitChange(unit)}
                >
                  {unit}
                </Button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">OFP altitudes:</span>
            <div className="flex gap-1.5">
              {(
                [
                  { unit: 'ft', label: 'Feet' },
                  { unit: 'm', label: 'Meters' },
                  { unit: 'hybrid', label: 'Hybrid' }
                ] as const
              ).map(({ unit, label }) => (
                <Button
                  key={unit}
                  type="button"
                  size="sm"
                  variant={props.altitudeUnit === unit ? 'default' : 'outline'}
                  onClick={() => props.onAltitudeUnitChange(unit)}
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            "Hybrid" shows each step climb in whichever unit it was actually planned in —
            feet for a standard level, meters for a route crossing into airspace (e.g.
            China) that assigns levels in meters — rather than converting everything to
            one unit.
          </p>
        </CardContent>
      </Card>

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
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Pre-authenticates plan generation for this app session. Doesn't persist across
              a restart, and Generate will prompt for login inline if you skip this.
            </p>
            <Button type="button" variant="outline" size="sm" onClick={handleLoginToNavigraph} disabled={loggingIn}>
              {loggingIn ? 'Logging in…' : 'Log in to Navigraph'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="max-w-sm">
        <CardHeader>
          <CardTitle>Cloud sync</CardTitle>
          <CardDescription>
            Sync Fleet and Logbook across your machines. Off by default — nothing leaves this device until you log
            in.
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
                <Button type="button" variant="outline" size="sm" onClick={handleSyncNow} disabled={syncStatus.syncing}>
                  {syncStatus.syncing ? 'Syncing…' : 'Sync now'}
                </Button>
              </div>
              {syncStatus.lastError && <p className="text-xs text-destructive">{syncStatus.lastError}</p>}
            </>
          ) : (
            <form onSubmit={handleCloudLogin} className="flex flex-col gap-3">
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
                  required
                />
              </Label>
              <Button type="submit" variant="outline" size="sm" className="w-fit" disabled={loggingIntoCloud}>
                {loggingIntoCloud ? 'Logging in…' : 'Log in'}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      <Card className="max-w-sm">
        <CardHeader>
          <CardTitle>Data</CardTitle>
          <CardDescription>Import or export your fleet and logbook as local files.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-foreground">Fleet (JSON)</span>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={handleImportAircraft} disabled={importingAircraft}>
                {importingAircraft ? 'Importing…' : 'Import'}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={handleExportAircraft}>
                Export
              </Button>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-foreground">Logbook (CSV)</span>
            <Button type="button" variant="outline" size="sm" onClick={handleImportLogbook} disabled={importingLogbook}>
              {importingLogbook ? 'Importing…' : 'Import'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="max-w-sm">
        <CardHeader>
          <CardTitle>Landing severity</CardTitle>
          <CardDescription>
            Touchdown rate thresholds for the firm/hard badges on Fleet and Logbook landing records. Real
            guidance varies by aircraft category — these are general-aviation-leaning defaults, not universal.
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

      <Card className="max-w-sm">
        <CardHeader>
          <CardTitle>GSX ground services</CardTitle>
          <CardDescription>
            Attach GSX Pro's catering/fuel/handling receipts to matching flights in your Logbook. Windows only
            (GSX itself is Windows-only) — off by default, and nothing here shows up until enabled.
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
              <Input type="text" readOnly value={gsx.folderPath ?? ''} placeholder="Not set" className="flex-1" />
              <Button type="button" variant="outline" size="sm" onClick={handleGsxBrowse}>
                Browse…
              </Button>
            </div>
          </Label>
          <p className="text-xs text-muted-foreground">
            Usually %APPDATA%\Virtuali\GSX\Receipts. A path that's wrong or no longer exists just means no
            receipts are found — never an error.
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
            GSX totals convert using a live rate fetched at the time you view them — nothing is stored converted.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
