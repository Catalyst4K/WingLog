/** The app shell: the tabs, the settings they share, and the app-wide banners and dialogs. */

import { lazy, Suspense, useEffect } from 'react'
import type { AppPage as AppPageId, SimTelemetry } from '@shared/ipc'
import { SetupDialog } from './SetupDialog'
import { UpdateBanner } from './UpdateBanner'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs } from '@/components/ui/tabs'
import { Toaster } from '@/components/ui/sonner'
import { FleetView } from './FleetView'
import { asyncHandler, runAsync } from './report-error'
import { AppHeader } from './app/AppHeader'
import { AtcClearanceDialog, ImportantGsxMenuDialog, OrphanedFlightDialog } from './app/AppDialogs'
import {
  useAtcClearancePrompt,
  useFirstLaunchSetup,
  useFlightPlan,
  useImportantGsxMenu,
  useNavigation,
  useOrphanedFlight,
  useSimConnection,
  type FlightPlan,
  type Navigation
} from './app/use-app-state'
import { useDisplaySettings, type DisplaySettings } from './app/use-display-settings'

// Fleet is the default/first tab, so it's the one view kept eager — every other tab is
// lazy so its JS (and, for Track/Logbook, the maplibre-gl and recharts they pull in —
// together the two heaviest dependencies in the app) doesn't get parsed and evaluated
// until the user actually visits it. docs/decisions.md, memory-usage entry.
const loadDispatchView = () => import('./DispatchView').then((m) => ({ default: m.DispatchView }))
const loadTrackView = () => import('./TrackView').then((m) => ({ default: m.TrackView }))
const loadGsxRemoteView = () => import('./GsxRemoteView').then((m) => ({ default: m.GsxRemoteView }))
const loadBeyondAtcView = () => import('./BeyondAtcView').then((m) => ({ default: m.BeyondAtcView }))
const loadLogbookView = () => import('./LogbookView').then((m) => ({ default: m.LogbookView }))
const loadSettingsView = () => import('./SettingsView').then((m) => ({ default: m.SettingsView }))
const DispatchView = lazy(loadDispatchView)
const TrackView = lazy(loadTrackView)
const GsxRemoteView = lazy(loadGsxRemoteView)
const BeyondAtcView = lazy(loadBeyondAtcView)
const LogbookView = lazy(loadLogbookView)
const SettingsView = lazy(loadSettingsView)

/**
 * Suspense's fallback for a lazy view's first render (docs/plans/navigation-tab-
 * behaviour.md) — belt-and-braces alongside the idle prefetch below, not the primary fix:
 * prefetching makes the cold-click delay go away, this just means a slow one (prefetch
 * hadn't finished yet) shows the page frame rather than nothing at all.
 *
 * @returns The element.
 */
function PageSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  )
}

/**
 * Prefetches every lazy view's chunk once the app is idle after first paint, so by the
 * time a tab is actually clicked its module is already in memory and `lazy` resolves
 * synchronously — this is what actually removes the first-visit delay (docs/plans/
 * navigation-tab-behaviour.md), the Suspense fallback is just the safety net for
 * whatever's still mid-fetch on a very cold click. requestIdleCallback isn't in every
 * browser but always is in Electron/Chromium; the setTimeout fallback costs nothing.
 */
function usePrefetchViews(): void {
  useEffect(() => {
    const idle: (cb: () => void) => number =
      typeof window.requestIdleCallback === 'function'
        ? window.requestIdleCallback
        : (cb) => window.setTimeout(cb, 1)
    const cancelIdle: (handle: number) => void =
      typeof window.cancelIdleCallback === 'function' ? window.cancelIdleCallback : window.clearTimeout
    const handle = idle(() => {
      runAsync('preload Dispatch view', loadDispatchView())
      runAsync('preload Track view', loadTrackView())
      runAsync('preload GsxRemote view', loadGsxRemoteView())
      runAsync('preload BeyondAtc view', loadBeyondAtcView())
      runAsync('preload Logbook view', loadLogbookView())
      runAsync('preload Settings view', loadSettingsView())
    })
    return () => cancelIdle(handle)
  }, [])
}

/**
 * The display settings' values and change handlers in the shape both SettingsView and
 * SetupDialog take, each handler reporting its own failure.
 *
 * @param settings The display settings.
 * @returns The props.
 */
function displaySettingsProps(
  settings: DisplaySettings
): Omit<React.ComponentProps<typeof SetupDialog>, 'open' | 'onClose'> {
  return {
    weightUnit: settings.weightUnit,
    onWeightUnitChange: asyncHandler('App handleWeightUnitChange', settings.onWeightUnitChange),
    altitudeUnit: settings.altitudeUnit,
    onAltitudeUnitChange: asyncHandler('App handleAltitudeUnitChange', settings.onAltitudeUnitChange),
    windSpeedUnit: settings.windSpeedUnit,
    onWindSpeedUnitChange: asyncHandler('App handleWindSpeedUnitChange', settings.onWindSpeedUnitChange),
    landingDistanceUnit: settings.landingDistanceUnit,
    onLandingDistanceUnitChange: asyncHandler(
      'App handleLandingDistanceUnitChange',
      settings.onLandingDistanceUnitChange
    ),
    mapLanguage: settings.mapLanguage,
    onMapLanguageChange: asyncHandler('App handleMapLanguageChange', settings.onMapLanguageChange),
    appLanguage: settings.appLanguage,
    onAppLanguageChange: asyncHandler('App handleAppLanguageChange', settings.onAppLanguageChange),
    onGsxRemoteEnabledChange: settings.setGsxRemoteEnabled,
    onBeyondAtcEnabledChange: settings.setBeyondAtcEnabled
  }
}

/**
 * The page for the current tab. Fleet renders straight away; the lazy views wait in Suspense.
 *
 * @param props The navigation state, display settings, flight plan, live telemetry, and the
 *   handler that reopens first-launch setup.
 * @returns The element.
 */
function CurrentPage(props: {
  nav: Navigation
  settings: DisplaySettings
  plan: FlightPlan
  telemetry: SimTelemetry | null
  onRunSetup: () => void
}): React.JSX.Element {
  const { nav, settings, plan } = props
  const page = nav.effectivePage
  return (
    <>
      {page === 'fleet' && (
        <FleetView
          onOpenFlightInLogbook={nav.openFlightInLogbook}
          initialAircraftId={nav.pendingFleetAircraftId}
          onInitialAircraftConsumed={nav.clearPendingFleetAircraftId}
          resetSignal={nav.fleetResetSignal}
        />
      )}
      <Suspense fallback={<PageSkeleton />}>
        {page === 'dispatch' && (
          <DispatchView
            weightUnit={settings.weightUnit}
            altitudeUnit={settings.altitudeUnit}
            windSpeedUnit={settings.windSpeedUnit}
            onPlanned={() => nav.setPage('track')}
            ofp={plan.dispatchOfp}
            onOfpChange={plan.onDispatchOfpChange}
            dispatchedOfpId={plan.dispatchedOfpId}
            onDispatchedOfpIdChange={plan.setDispatchedOfpId}
            selection={plan.procedureSelection}
            onSelectionChange={plan.setProcedureSelection}
          />
        )}
        {page === 'track' && (
          <TrackView
            windSpeedUnit={settings.windSpeedUnit}
            previewOfp={plan.dispatchOfp}
            telemetry={props.telemetry}
            mapLanguage={settings.mapLanguage}
            selection={plan.procedureSelection}
            onSelectionChange={plan.setProcedureSelection}
            onFlightEnded={plan.onFlightEnded}
          />
        )}
        {page === 'gsx' && <GsxRemoteView />}
        {page === 'beyondatc' && <BeyondAtcView />}
        {page === 'logbook' && (
          <LogbookView
            weightUnit={settings.weightUnit}
            landingDistanceUnit={settings.landingDistanceUnit}
            mapLanguage={settings.mapLanguage}
            initialFlightId={nav.pendingLogbookFlight?.flightId ?? null}
            initialFlightOriginAircraftId={nav.pendingLogbookFlight?.fromAircraftId ?? null}
            onInitialFlightConsumed={nav.clearPendingLogbookFlight}
            onBackToAircraft={nav.openFleetAircraft}
            resetSignal={nav.logbookResetSignal}
          />
        )}
        {page === 'settings' && (
          <SettingsView
            {...displaySettingsProps(settings)}
            theme={settings.theme}
            onThemeChange={asyncHandler('App handleThemeChange', settings.onThemeChange)}
            onRunSetup={props.onRunSetup}
            resetSignal={nav.settingsResetSignal}
          />
        )}
      </Suspense>
    </>
  )
}

/**
 * The app.
 *
 * @returns The element.
 */
export default function App(): React.JSX.Element {
  const settings = useDisplaySettings()
  const plan = useFlightPlan()
  const nav = useNavigation(settings.gsxRemoteEnabled, settings.beyondAtcEnabled)
  const orphaned = useOrphanedFlight(plan, () => nav.setPage('track'))
  const atcClearance = useAtcClearancePrompt(plan.procedureSelection, plan.setProcedureSelection)
  usePrefetchViews()
  const { setupOpen, setSetupOpen } = useFirstLaunchSetup()
  const gsxMenu = useImportantGsxMenu(nav.effectivePage === 'gsx')
  const { simStatus, telemetry } = useSimConnection()

  return (
    <main className="flex h-screen flex-col">
      <UpdateBanner airborne={telemetry !== null && !telemetry.onGround} />
      <Tabs
        value={nav.effectivePage}
        onValueChange={(value) => nav.setPage(value as AppPageId)}
        className="min-h-0 flex-1 gap-0"
      >
        <AppHeader
          gsxRemoteEnabled={settings.gsxRemoteEnabled}
          beyondAtcEnabled={settings.beyondAtcEnabled}
          onTabClick={nav.goToTab}
          simStatus={simStatus}
        />

        {/* min-h-0 overrides the flex-item default of min-height:auto — without it, a
            tall page (e.g. Logbook's full flight list) forces this div past its 100vh
            budget instead of clipping to it, and the whole document scrolls (dragging
            the header above away with it) instead of just this div
            (flight-test-findings-2026-09-06.md #7 — confirmed live: the outer <main> was
            measurably taller than the viewport, not this div). */}
        <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-8">
          <CurrentPage
            nav={nav}
            settings={settings}
            plan={plan}
            telemetry={telemetry}
            onRunSetup={() => setSetupOpen(true)}
          />
        </div>
      </Tabs>
      <Toaster />
      <SetupDialog open={setupOpen} onClose={() => setSetupOpen(false)} {...displaySettingsProps(settings)} />

      <OrphanedFlightDialog
        flight={orphaned.orphanedFlight}
        onClose={orphaned.onClose}
        onResume={orphaned.onResume}
        onDiscard={orphaned.onDiscard}
      />
      <ImportantGsxMenuDialog menu={gsxMenu.menu} open={gsxMenu.open} onDismiss={gsxMenu.onDismiss} />
      <AtcClearanceDialog
        clearance={atcClearance.pending}
        selection={plan.procedureSelection}
        onAccept={atcClearance.onAccept}
        onDismiss={atcClearance.onDismiss}
      />
    </main>
  )
}
