import { lazy, Suspense, useEffect, useState } from 'react'
import { BookOpen, Plane, Radar, Route, Settings as SettingsIcon } from 'lucide-react'
import { toast } from 'sonner'
import type {
  AltitudeUnit,
  AppPage,
  DispatchOfp,
  ProcedureSelection,
  SimConnectionStatus,
  SimTelemetry,
  Theme,
  WeightUnit,
  WindSpeedUnit
} from '@shared/ipc'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Toaster } from '@/components/ui/sonner'
import { FleetView } from './FleetView'
import { emptyProcedureSelection, seedProcedureSelectionFromOfp } from './procedureSelection'

// Fleet is the default/first tab, so it's the one view kept eager — every other tab is
// lazy so its JS (and, for Track/Logbook, the maplibre-gl and recharts they pull in —
// together the two heaviest dependencies in the app) doesn't get parsed and evaluated
// until the user actually visits it. docs/decisions.md, memory-usage entry.
const loadDispatchView = () => import('./DispatchView').then((m) => ({ default: m.DispatchView }))
const loadTrackView = () => import('./TrackView').then((m) => ({ default: m.TrackView }))
const loadLogbookView = () => import('./LogbookView').then((m) => ({ default: m.LogbookView }))
const loadSettingsView = () => import('./SettingsView').then((m) => ({ default: m.SettingsView }))
const DispatchView = lazy(loadDispatchView)
const TrackView = lazy(loadTrackView)
const LogbookView = lazy(loadLogbookView)
const SettingsView = lazy(loadSettingsView)

const TABS: { page: AppPage; label: string; icon: typeof Plane }[] = [
  { page: 'fleet', label: 'Fleet', icon: Plane },
  { page: 'dispatch', label: 'Dispatch', icon: Route },
  { page: 'track', label: 'Track', icon: Radar },
  { page: 'logbook', label: 'Logbook', icon: BookOpen },
  { page: 'settings', label: 'Settings', icon: SettingsIcon }
]

/** Suspense's fallback for a lazy view's first render (docs/plans/navigation-tab-
 *  behaviour.md) — belt-and-braces alongside the idle prefetch below, not the primary fix:
 *  prefetching makes the cold-click delay go away, this just means a slow one (prefetch
 *  hadn't finished yet) shows the page frame rather than nothing at all. */
function PageSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  )
}

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
  const [theme, setTheme] = useState<Theme>('system')
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
  // The live procedure selection — lifted here (not local to either view) so Dispatch and
  // Track always agree on what's currently chosen, with no save step between them
  // (docs/plans/navdata-without-navigraph.md, Phase 5). Re-seeded from SimBrief's own
  // choice whenever a genuinely new OFP loads — see handleDispatchOfpChange below.
  const [procedureSelection, setProcedureSelection] = useState<ProcedureSelection>(emptyProcedureSelection())

  // Wraps setDispatchOfp so a *new* OFP (a different ofpId, including "cleared to null")
  // always re-seeds the procedure selection from its own SimBrief choice — the previous
  // plan's selection must never leak onto a different one. Re-fetching/re-saving the exact
  // same OFP the user's already been editing (ofpId unchanged) leaves the selection alone,
  // or every dropdown edit would be wiped out from under them.
  function handleDispatchOfpChange(ofp: DispatchOfp | null): void {
    if ((ofp?.ofpId ?? null) !== (dispatchOfp?.ofpId ?? null)) {
      setProcedureSelection(ofp ? seedProcedureSelectionFromOfp(ofp.ofpJson) : emptyProcedureSelection())
    }
    setDispatchOfp(ofp)
  }
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
  // Bumped to tell an already-mounted view "return to your default view" — a tab click
  // while already on that tab doesn't change `page`, so it doesn't remount the view (which
  // would otherwise reset it for free) or fire Radix's onValueChange at all (docs/plans/
  // navigation-tab-behaviour.md). Only Fleet/Logbook/Settings have a real list -> detail
  // drill-down to reset this way; Dispatch/Track don't get one, see goToTab below.
  const [fleetResetSignal, setFleetResetSignal] = useState(0)
  const [logbookResetSignal, setLogbookResetSignal] = useState(0)
  const [settingsResetSignal, setSettingsResetSignal] = useState(0)

  function openFlightInLogbook(flightId: number, fromAircraftId: number): void {
    setPendingLogbookFlight({ flightId, fromAircraftId })
    setPage('logbook')
  }

  /** Always navigates to `targetPage` — including "return to its default view" when
   *  already there, which a bare `setPage` can't do (Radix's Tabs only fires
   *  `onValueChange` on an actual value change, so clicking the active tab is normally a
   *  no-op). Dispatch and Track are deliberate exceptions: their lifted state
   *  (`dispatchOfp`/`dispatchedOfpId`, Track's own in-progress tracking) is work in
   *  progress, not navigation history — clearing it because the user clicked the tab
   *  they're already on would be a data-loss bug wearing a UX fix's clothing. */
  function goToTab(targetPage: AppPage): void {
    if (targetPage !== page) {
      setPage(targetPage)
      return
    }
    if (targetPage === 'fleet') setFleetResetSignal((n) => n + 1)
    if (targetPage === 'logbook') setLogbookResetSignal((n) => n + 1)
    if (targetPage === 'settings') setSettingsResetSignal((n) => n + 1)
  }

  // Prefetches every lazy view's chunk once the app is idle after first paint, so by the
  // time a tab is actually clicked its module is already in memory and `lazy` resolves
  // synchronously — this is what actually removes the first-visit delay (docs/plans/
  // navigation-tab-behaviour.md), the Suspense fallback below is just the safety net for
  // whatever's still mid-fetch on a very cold click. requestIdleCallback isn't in every
  // browser but always is in Electron/Chromium; the setTimeout fallback costs nothing.
  useEffect(() => {
    const idle: (cb: () => void) => number =
      typeof window.requestIdleCallback === 'function'
        ? window.requestIdleCallback
        : (cb) => window.setTimeout(cb, 1)
    const cancelIdle: (handle: number) => void =
      typeof window.cancelIdleCallback === 'function' ? window.cancelIdleCallback : window.clearTimeout
    const handle = idle(() => {
      void loadDispatchView()
      void loadTrackView()
      void loadLogbookView()
      void loadSettingsView()
    })
    return () => cancelIdle(handle)
  }, [])

  function openFleetAircraft(aircraftId: number): void {
    setPendingFleetAircraftId(aircraftId)
    setPage('fleet')
  }

  useEffect(() => {
    window.winglog.settingsGetWeightUnit().then(setWeightUnit)
    window.winglog.settingsGetAltitudeUnit().then(setAltitudeUnit)
    window.winglog.settingsGetWindSpeedUnit().then(setWindSpeedUnit)
    window.winglog.settingsGetTheme().then(setTheme)
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

  async function handleThemeChange(next: Theme): Promise<void> {
    setTheme(next)
    await window.winglog.settingsSetTheme(next)
  }

  useEffect(() => {
    // A no-op (returns null) on every launch after the app's actual first-ever one —
    // see settingsCheckGsxFirstLaunch's doc comment.
    window.winglog.settingsCheckGsxFirstLaunch().then((result) => {
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
    window.winglog.getSimConnectionStatus().then(setSimStatus)
    const unsubscribeStatus = window.winglog.onSimConnectionStatus((status) => {
      setSimStatus(status)
      // The sim stopped sending updates — clear the last-known values rather than
      // leaving them frozen on screen (e.g. Track's map overlay) looking current.
      if (status.state !== 'connected') setTelemetry(null)
    })
    const unsubscribeTelemetry = window.winglog.onSimTelemetry(setTelemetry)
    return () => {
      unsubscribeStatus()
      unsubscribeTelemetry()
    }
  }, [])

  async function handleWeightUnitChange(unit: WeightUnit): Promise<void> {
    setWeightUnit(unit)
    await window.winglog.settingsSetWeightUnit(unit)
  }

  async function handleAltitudeUnitChange(unit: AltitudeUnit): Promise<void> {
    setAltitudeUnit(unit)
    await window.winglog.settingsSetAltitudeUnit(unit)
  }

  async function handleWindSpeedUnitChange(unit: WindSpeedUnit): Promise<void> {
    setWindSpeedUnit(unit)
    await window.winglog.settingsSetWindSpeedUnit(unit)
  }

  return (
    <main className="flex h-screen flex-col">
      <Tabs value={page} onValueChange={(value) => setPage(value as AppPage)} className="min-h-0 flex-1 gap-0">
        <header className="flex items-center justify-between gap-4 border-b border-border px-6 py-3">
          <TabsList variant="line">
            {TABS.map(({ page: tabPage, label, icon: Icon }) => (
              <TabsTrigger
                key={tabPage}
                value={tabPage}
                className="gap-1.5 px-3"
                onClick={() => goToTab(tabPage)}
              >
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
              resetSignal={fleetResetSignal}
            />
          )}
          <Suspense fallback={<PageSkeleton />}>
            {page === 'dispatch' && (
              <DispatchView
                weightUnit={weightUnit}
                altitudeUnit={altitudeUnit}
                windSpeedUnit={windSpeedUnit}
                onPlanned={() => setPage('track')}
                ofp={dispatchOfp}
                onOfpChange={handleDispatchOfpChange}
                dispatchedOfpId={dispatchedOfpId}
                onDispatchedOfpIdChange={setDispatchedOfpId}
                selection={procedureSelection}
                onSelectionChange={setProcedureSelection}
              />
            )}
            {page === 'track' && (
              <TrackView
                previewOfp={dispatchOfp}
                telemetry={telemetry}
                selection={procedureSelection}
                onSelectionChange={setProcedureSelection}
                onFlightEnded={() => {
                  handleDispatchOfpChange(null)
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
                resetSignal={logbookResetSignal}
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
                theme={theme}
                onThemeChange={handleThemeChange}
                resetSignal={settingsResetSignal}
              />
            )}
          </Suspense>
        </div>
      </Tabs>
      <Toaster />
    </main>
  )
}
