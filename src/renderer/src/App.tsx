import { lazy, Suspense, useEffect, useState } from 'react'
import { BookOpen, Plane, Radar, Route, Settings as SettingsIcon } from 'lucide-react'
import { toast } from 'sonner'
import type {
  AltitudeUnit,
  AppPage,
  DispatchOfp,
  SimConnectionStatus,
  SimTelemetry,
  WeightUnit,
  WindSpeedUnit
} from '@shared/ipc'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Toaster } from '@/components/ui/sonner'
import { FleetView } from './FleetView'

// Fleet is the default/first tab, so it's the one view kept eager — every other tab is
// lazy so its JS (and, for Track/Logbook, the maplibre-gl and recharts they pull in —
// together the two heaviest dependencies in the app) doesn't get parsed and evaluated
// until the user actually visits it. docs/decisions.md, memory-usage entry.
const DispatchView = lazy(() => import('./DispatchView').then((m) => ({ default: m.DispatchView })))
const TrackView = lazy(() => import('./TrackView').then((m) => ({ default: m.TrackView })))
const LogbookView = lazy(() => import('./LogbookView').then((m) => ({ default: m.LogbookView })))
const SettingsView = lazy(() => import('./SettingsView').then((m) => ({ default: m.SettingsView })))

const TABS: { page: AppPage; label: string; icon: typeof Plane }[] = [
  { page: 'fleet', label: 'Fleet', icon: Plane },
  { page: 'dispatch', label: 'Dispatch', icon: Route },
  { page: 'track', label: 'Track', icon: Radar },
  { page: 'logbook', label: 'Logbook', icon: BookOpen },
  { page: 'settings', label: 'Settings', icon: SettingsIcon }
]

function connectionStatusLabel(status: SimConnectionStatus): string {
  switch (status.state) {
    case 'connected':
      return `Connected (SimConnect ${status.simConnectVersion})`
    case 'connecting':
      return 'Connecting…'
    case 'disconnected':
      return 'Disconnected — retrying'
  }
}

function connectionStatusVariant(status: SimConnectionStatus): 'default' | 'secondary' | 'destructive' {
  switch (status.state) {
    case 'connected':
      return 'default'
    case 'connecting':
      return 'secondary'
    case 'disconnected':
      return 'destructive'
  }
}

export default function App(): React.JSX.Element {
  const [page, setPage] = useState<AppPage>('fleet')
  const [weightUnit, setWeightUnit] = useState<WeightUnit>('lb')
  const [altitudeUnit, setAltitudeUnit] = useState<AltitudeUnit>('ft')
  const [windSpeedUnit, setWindSpeedUnit] = useState<WindSpeedUnit>('kt')
  const [simStatus, setSimStatus] = useState<SimConnectionStatus>({ state: 'disconnected' })
  const [telemetry, setTelemetry] = useState<SimTelemetry | null>(null)
  // Lifted out of DispatchView (rather than local state there) for two reasons: Track
  // needs to preview a fetched-but-not-yet-saved OFP, and Dispatch itself needs the OFP
  // to survive switching away to Track and back — Dispatch doubles as a weights/info
  // reference for whatever's currently dispatched, not just a one-shot planning form.
  const [dispatchOfp, setDispatchOfp] = useState<DispatchOfp | null>(null)
  // ofpId of the OFP that's already been turned into a flight — lets Dispatch tell "still
  // planning this" from "already flying this, showing it for reference" apart, and that
  // distinction has to survive the same tab-switch-and-back as dispatchOfp itself.
  const [dispatchedOfpId, setDispatchedOfpId] = useState<string | null>(null)
  // Set when Fleet's per-aircraft flight list navigates to a specific flight's Logbook
  // detail. Lifted here (rather than local to LogbookView) because it has to survive the
  // page switch from Fleet to Logbook that triggers it. Carries the originating aircraft
  // id too, so Logbook's back button can return to that aircraft instead of always
  // landing on Logbook's own list — see openFleetAircraft below for the reverse trip.
  const [pendingLogbookFlight, setPendingLogbookFlight] = useState<{
    flightId: number
    fromAircraftId: number
  } | null>(null)
  // Mirror of the above for the trip back — set when Logbook's "Back" returns to a
  // specific aircraft rather than the Fleet list.
  const [pendingFleetAircraftId, setPendingFleetAircraftId] = useState<number | null>(null)

  function openFlightInLogbook(flightId: number, fromAircraftId: number): void {
    setPendingLogbookFlight({ flightId, fromAircraftId })
    setPage('logbook')
  }

  function openFleetAircraft(aircraftId: number): void {
    setPendingFleetAircraftId(aircraftId)
    setPage('fleet')
  }

  useEffect(() => {
    window.flightdeck.settingsGetWeightUnit().then(setWeightUnit)
    window.flightdeck.settingsGetAltitudeUnit().then(setAltitudeUnit)
    window.flightdeck.settingsGetWindSpeedUnit().then(setWindSpeedUnit)
  }, [])

  useEffect(() => {
    // A no-op (returns null) on every launch after the app's actual first-ever one —
    // see settingsCheckGsxFirstLaunch's doc comment.
    window.flightdeck.settingsCheckGsxFirstLaunch().then((result) => {
      if (!result) return
      if (result.found) {
        toast.success('GSX ground-service tracking enabled — receipts folder found automatically.')
      } else {
        toast.info('GSX ground-service tracking is off — enable it in Settings if you use GSX.')
      }
    })
  }, [])

  useEffect(() => {
    // Pull current status in case the initial connect (main process starts it immediately
    // on app launch) already resolved before this component mounted — the push channel
    // below only delivers *future* changes, Electron doesn't replay missed IPC sends.
    window.flightdeck.getSimConnectionStatus().then(setSimStatus)
    const unsubscribeStatus = window.flightdeck.onSimConnectionStatus((status) => {
      setSimStatus(status)
      // The sim stopped sending updates — clear the last-known values rather than
      // leaving them frozen on screen (e.g. Track's map overlay) looking current.
      if (status.state !== 'connected') setTelemetry(null)
    })
    const unsubscribeTelemetry = window.flightdeck.onSimTelemetry(setTelemetry)
    return () => {
      unsubscribeStatus()
      unsubscribeTelemetry()
    }
  }, [])

  async function handleWeightUnitChange(unit: WeightUnit): Promise<void> {
    setWeightUnit(unit)
    await window.flightdeck.settingsSetWeightUnit(unit)
  }

  async function handleAltitudeUnitChange(unit: AltitudeUnit): Promise<void> {
    setAltitudeUnit(unit)
    await window.flightdeck.settingsSetAltitudeUnit(unit)
  }

  async function handleWindSpeedUnitChange(unit: WindSpeedUnit): Promise<void> {
    setWindSpeedUnit(unit)
    await window.flightdeck.settingsSetWindSpeedUnit(unit)
  }

  return (
    <main className="flex h-screen flex-col">
      <Tabs value={page} onValueChange={(value) => setPage(value as AppPage)} className="min-h-0 flex-1 gap-0">
        <header className="flex items-center justify-between gap-4 border-b border-border px-6 py-3">
          <TabsList variant="line">
            {TABS.map(({ page: tabPage, label, icon: Icon }) => (
              <TabsTrigger key={tabPage} value={tabPage} className="gap-1.5 px-3">
                <Icon />
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
          <Badge variant={connectionStatusVariant(simStatus)} title={connectionStatusLabel(simStatus)}>
            SimConnect: {simStatus.state}
          </Badge>
        </header>

        {/* min-h-0 overrides the flex-item default of min-height:auto — without it, a
            tall page (e.g. Logbook's full flight list) forces this div past its 100vh
            budget instead of clipping to it, and the whole document scrolls (dragging
            the header above away with it) instead of just this div
            (flight-test-findings-2026-09-06.md #7 — confirmed live: the outer <main> was
            measurably taller than the viewport, not this div). */}
        <div className="min-h-0 flex-1 overflow-auto p-8">
          {page === 'fleet' && (
            <FleetView
              onOpenFlightInLogbook={openFlightInLogbook}
              initialAircraftId={pendingFleetAircraftId}
              onInitialAircraftConsumed={() => setPendingFleetAircraftId(null)}
            />
          )}
          <Suspense fallback={null}>
            {page === 'dispatch' && (
              <DispatchView
                weightUnit={weightUnit}
                altitudeUnit={altitudeUnit}
                windSpeedUnit={windSpeedUnit}
                onPlanned={() => setPage('track')}
                ofp={dispatchOfp}
                onOfpChange={setDispatchOfp}
                dispatchedOfpId={dispatchedOfpId}
                onDispatchedOfpIdChange={setDispatchedOfpId}
              />
            )}
            {page === 'track' && (
              <TrackView
                previewOfpJson={dispatchOfp?.ofpJson ?? null}
                telemetry={telemetry}
                onFlightEnded={() => {
                  setDispatchOfp(null)
                  setDispatchedOfpId(null)
                }}
              />
            )}
            {page === 'logbook' && (
              <LogbookView
                weightUnit={weightUnit}
                initialFlightId={pendingLogbookFlight?.flightId ?? null}
                initialFlightOriginAircraftId={pendingLogbookFlight?.fromAircraftId ?? null}
                onInitialFlightConsumed={() => setPendingLogbookFlight(null)}
                onBackToAircraft={openFleetAircraft}
              />
            )}
            {page === 'settings' && (
              <SettingsView
                weightUnit={weightUnit}
                onWeightUnitChange={handleWeightUnitChange}
                altitudeUnit={altitudeUnit}
                onAltitudeUnitChange={handleAltitudeUnitChange}
                windSpeedUnit={windSpeedUnit}
                onWindSpeedUnitChange={handleWindSpeedUnitChange}
              />
            )}
          </Suspense>
        </div>
      </Tabs>
      <Toaster />
    </main>
  )
}
