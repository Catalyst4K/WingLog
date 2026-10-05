import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { BookOpen, Plane, Radar, Radio, Route, Settings as SettingsIcon, Truck } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type {
  AltitudeUnit,
  AppLanguage,
  AppPage,
  BeyondAtcTranscriptEntry,
  DispatchOfp,
  Flight,
  GsxRemoteMenuState,
  LandingDistanceUnit,
  MapLanguage,
  ProcedureSelection,
  SimConnectionStatus,
  SimTelemetry,
  Theme,
  WeightUnit,
  WindSpeedUnit
} from '@shared/ipc'
import { resolveAppLanguage } from '@shared/app-language'
import { SetupDialog } from './SetupDialog'
import { UpdateBanner } from './UpdateBanner'
import i18n from './i18n'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Toaster } from '@/components/ui/sonner'
import { FleetView } from './FleetView'
import { flightLabel } from './flight-label'
import { gsxMenuSignature, isImportantGsxMenu } from './gsx-remote-importance'
import { emptyProcedureSelection, seedProcedureSelectionFromOfp, selectionFromFlight } from './procedureSelection'
import { parseAtcClearance, type AtcClearanceUpdate } from './atcClearanceParser'
import { approachForArrivalRunway, matchClearanceApproach } from './atcApproachMatch'

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

/** GSX Remote Control and BeyondATC's own tabs are gated on their settings' `enabled` flag
 *  (Callum, 2026-09-27) — hidden until turned on in Settings, rather than always shown
 *  regardless of configuration. */
/** Maps a parsed clearance's ProcedureSelection field name to its existing ProcedureSelector
 *  label key — reused rather than duplicated, same fields, same meaning. */
const ATC_CLEARANCE_FIELD_LABEL_KEYS: Partial<Record<keyof ProcedureSelection, string>> = {
  departureRunway: 'procedureSelector.departureRunway',
  sidIdent: 'procedureSelector.sid',
  starIdent: 'procedureSelector.star',
  approachIdent: 'procedureSelector.approach',
  approachTransition: 'procedureSelector.approachTransition'
}

function appTabs(t: TFunction, gsxRemoteEnabled: boolean, beyondAtcEnabled: boolean): { page: AppPage; label: string; icon: typeof Plane }[] {
  return [
    { page: 'fleet', label: t('app.tabs.fleet'), icon: Plane },
    { page: 'dispatch', label: t('app.tabs.dispatch'), icon: Route },
    { page: 'track', label: t('app.tabs.track'), icon: Radar },
    ...(gsxRemoteEnabled ? [{ page: 'gsx' as const, label: t('app.tabs.gsx'), icon: Truck }] : []),
    ...(beyondAtcEnabled ? [{ page: 'beyondatc' as const, label: t('app.tabs.beyondAtc'), icon: Radio }] : []),
    { page: 'logbook', label: t('app.tabs.logbook'), icon: BookOpen },
    { page: 'settings', label: t('app.tabs.settings'), icon: SettingsIcon }
  ]
}

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

function connectionStatusLabel(status: SimConnectionStatus, t: TFunction): string {
  switch (status.state) {
    case 'connected':
      return t('app.connection.connected', { version: status.simConnectVersion })
    case 'connecting':
      return t('app.connection.connecting')
    case 'disconnected':
      return t('app.connection.disconnected')
  }
}

function connectionStateLabel(status: SimConnectionStatus, t: TFunction): string {
  return t(`app.connection.states.${status.state}`)
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

/** The resume/discard prompt covers two different situations under one flight row — a
 *  genuinely 'active' one (WingLog quit or crashed mid-track, TrackingController's
 *  in-memory phase-detection state was lost with it) and a merely 'planned' one (Fly was
 *  pressed, but tracking never actually started before WingLog closed — nothing crashed,
 *  there's just an unfinished plan). Same two choices either way (keep it or discard/delete
 *  it), but the wording needs to say which one it actually is, not always claim tracking
 *  was interrupted when it may never have started. */
function orphanedFlightCopy(
  flight: Flight,
  t: TFunction
): { title: string; description: string; confirmLabel: string } {
  const label = flightLabel(flight)
  return flight.status === 'active'
    ? {
        title: t('app.orphanedFlight.resumeTitle'),
        description: t('app.orphanedFlight.resumeDescription', { label }),
        confirmLabel: t('app.orphanedFlight.resumeConfirm')
      }
    : {
        title: t('app.orphanedFlight.continueTitle'),
        description: t('app.orphanedFlight.continueDescription', { label }),
        confirmLabel: t('app.orphanedFlight.continueConfirm')
      }
}

export default function App(): React.JSX.Element {
  const { t } = useTranslation()
  const [page, setPage] = useState<AppPage>('fleet')
  const [weightUnit, setWeightUnit] = useState<WeightUnit>('lb')
  const [altitudeUnit, setAltitudeUnit] = useState<AltitudeUnit>('ft')
  const [windSpeedUnit, setWindSpeedUnit] = useState<WindSpeedUnit>('kt')
  const [mapLanguage, setMapLanguage] = useState<MapLanguage>('en')
  const [appLanguage, setAppLanguage] = useState<AppLanguage>('system')
  const [landingDistanceUnit, setLandingDistanceUnit] = useState<LandingDistanceUnit>('ft')
  const [theme, setTheme] = useState<Theme>('system')
  // Gates the GSX Remote Control / BeyondATC tabs (appTabs below) — both start hidden until
  // their own settings are loaded, then track live toggles from SettingsView via the
  // onXEnabledChange callbacks passed to it, so a tab appears/disappears immediately rather
  // than only after the next app restart.
  const [gsxRemoteEnabled, setGsxRemoteEnabled] = useState(false)
  const [beyondAtcEnabled, setBeyondAtcEnabled] = useState(false)
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
  // The one flight left "in progress" (planned or already active) by a previous process —
  // either a genuine crash/quit mid-track, or just Fly pressed and never followed through
  // (no crash at all, tracking simply never started). Its own DB row (OFP, route,
  // everything Dispatch/Track need) was never at risk either way, only TrackingController's
  // in-memory phase-detection state, which only exists once a flight reaches 'active'.
  // Neither resuming nor continuing is automatic — only the user can judge whether it's
  // still relevant — so this drives a one-time prompt instead (checked once at startup
  // below; orphanedFlightCopy adapts the wording to whichever status it actually is).
  const [orphanedFlight, setOrphanedFlight] = useState<Flight | null>(null)
  // GSX's live menu, tracked here (not just inside GsxRemoteView) so an "important" one —
  // pushback direction, fuel amount, Callum's explicit call, 2026-09-21 — can interrupt
  // wherever the user currently is, not just when they happen to be on the GSX tab.
  // Everything else GSX might ask stays confined to that tab, unflagged, resolved by GSX's
  // own default/timeout if nobody answers there (flightdeck-backend's docs/gsx-notes.md).
  const [gsxMenu, setGsxMenu] = useState<GsxRemoteMenuState | null>(null)
  // Remembers which exact menu the user dismissed without answering, so closing the global
  // prompt doesn't just reopen itself on the next unrelated re-render — only a genuinely
  // different menu (a new signature) triggers it again.
  const [dismissedGsxMenuKey, setDismissedGsxMenuKey] = useState<string | null>(null)
  // A parsed BeyondATC clearance that differs from the current procedure selection, awaiting
  // the user's accept/dismiss — Callum's own precedence decision, 2026-09-25: overwrite, but
  // ask first, gently. Unlike gsxMenu above, no remembered-dismissal key is needed: a
  // transcript line is a one-shot event (lastAtcClearanceTs below already stops it being
  // rescanned), not persistent state that keeps re-arriving unchanged.
  const [pendingAtcClearance, setPendingAtcClearance] = useState<(AtcClearanceUpdate & { sourceTs: number }) | null>(null)
  // Watermark of the newest transcript entry already scanned — onBeyondAtcTranscript delivers
  // the whole buffer on every push (shared/ipc.ts), not just the new line, so this is what
  // tells a genuinely new entry apart from one already considered (and possibly dismissed).
  const lastAtcClearanceTs = useRef(0)

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

  // Called whenever a flight stops being current — cancelled, finished manually, or
  // auto-completed via shutdown detection — so Dispatch's own OFP/route reference doesn't
  // go on claiming to reference a flight that's no longer in progress. Passed to TrackView
  // as onFlightEnded for the manual cases (only reachable while Track is actually mounted),
  // and also driven directly below for the auto-detected shutdown case, which must clear
  // this regardless of which tab the user is on when it fires — see the effect below.
  function handleFlightEnded(): void {
    handleDispatchOfpChange(null)
    setDispatchedOfpId(null)
  }

  // Kept in sync with the latest handleFlightEnded closure on every render (same pattern as
  // TrackView's own onFlightEndedRef) so the mount-once subscription below never calls back
  // into a stale `dispatchOfp` from whatever render happened to be current when it first
  // subscribed.
  const handleFlightEndedRef = useRef(handleFlightEnded)
  useEffect(() => {
    handleFlightEndedRef.current = handleFlightEnded
  })

  // A flight can auto-complete (shutdown detection) while the user is on any tab, not just
  // Track — TrackView's own onTrackingPoint subscription only exists while it's mounted, so
  // relying on that alone left Dispatch showing a finished flight's OFP/route indefinitely
  // whenever Track wasn't open at the moment shutdown fired (real report, 2026-09-27).
  // Subscribed here instead, at the top level, so it fires no matter what's currently on
  // screen.
  useEffect(() => {
    return window.winglog.onTrackingPoint((point) => {
      if (point.phase === 'shutdown') handleFlightEndedRef.current()
    })
  }, [])

  useEffect(() => {
    window.winglog.trackingGetOrphanedFlight().then(setOrphanedFlight)
  }, [])

  // Restores Dispatch's own view of whatever flight is currently "in progress" (planned
  // or already active) after a restart — its own dispatchOfp/dispatchedOfpId are
  // renderer-only state that don't survive one, unlike Track's flight list, which reads
  // the DB directly and was never the problem. Uses the raw setters, not
  // handleDispatchOfpChange, so this doesn't also re-seed procedureSelection from
  // SimBrief's own choice — selectionFromFlight below already restores whatever was last
  // actually chosen (SimBrief's plan if nothing was ever touched, a live edit otherwise —
  // see handleSaveFlight, which persists props.selection at the moment Fly is pressed).
  useEffect(() => {
    window.winglog.dispatchGetInProgressFlight().then((result) => {
      if (!result) return
      setDispatchOfp(result.ofp)
      setDispatchedOfpId(result.ofp.ofpId)
      setProcedureSelection(selectionFromFlight(result.flight))
    })
  }, [])

  async function handleResumeOrphaned(): Promise<void> {
    if (!orphanedFlight) return
    await window.winglog.trackingResumeOrphaned(orphanedFlight.id)
    // The flight's own persisted selection (whatever was last chosen before the crash),
    // not a blank one — matches how a completed flight's Logbook map reads its selection
    // back (selectionFromFlight), just resuming instead of reviewing.
    setProcedureSelection(selectionFromFlight(orphanedFlight))
    setPage('track')
    setOrphanedFlight(null)
  }

  async function handleDiscardOrphaned(): Promise<void> {
    if (!orphanedFlight) return
    await window.winglog.trackingDiscardOrphaned(orphanedFlight.id)
    // The dispatch-hydration effect above may have already restored Dispatch's view of
    // this exact flight (it runs independently, before the user gets a chance to answer
    // this prompt) — clear it back out rather than leaving Dispatch showing a "Flying"
    // badge for a flight that's now abandoned.
    if (orphanedFlight.ofpId && orphanedFlight.ofpId === dispatchOfp?.ofpId) {
      handleDispatchOfpChange(null)
      setDispatchedOfpId(null)
    }
    setOrphanedFlight(null)
  }

  function handlePickGsxMenu(index: number): void {
    window.winglog.gsxRemotePickMenu(index)
    // GSX will clear/replace state.menu itself once the pick is processed — no need to
    // clear gsxMenu here too, and doing so would just make the dialog flash closed then
    // (possibly) reopen for the next patch.
  }

  // Scans new BeyondATC transcript entries for a parseable clearance whose fields differ from
  // the current selection — re-subscribes whenever procedureSelection changes so a diff is
  // always checked against the live value, the same "just resubscribe, it's cheap" style
  // procedureSelection.ts's own fetch effects already use.
  useEffect(() => {
    return window.winglog.onBeyondAtcTranscript((transcript: BeyondAtcTranscriptEntry[]) => {
      let latest: (AtcClearanceUpdate & { sourceTs: number }) | null = null
      for (const entry of transcript) {
        if (entry.speaker !== 'atc' || entry.ts <= lastAtcClearanceTs.current) continue
        lastAtcClearanceTs.current = entry.ts
        const update = parseAtcClearance(entry.text)
        if (update) latest = { ...update, sourceTs: entry.ts }
      }
      if (!latest) return
      const candidate: AtcClearanceUpdate & { sourceTs: number } = latest
      void (async () => {
        let update: AtcClearanceUpdate | null = candidate
        // ATC names approaches the way they're spoken ("R-NAV approach runway 02L"); swap in
        // the arrival airport's own name so accepting it selects something real (WSSS,
        // 2026-10-02). The airport is the one being flown to: the selected arrival, else
        // BeyondATC's own route.
        // A STAR clearance's runway picks the approach for it when it isn't the selected
        // approach's runway (EGLL, 2026-10-05: "cleared LOGA2H arrival, runway 27R" against a
        // planned ILS 27L).
        if (update.fields.approachIdent || update.arrivalRunway) {
          try {
            const icao = procedureSelection.arrivalIcao ?? (await window.winglog.beyondAtcGetState()).progress?.to ?? null
            if (icao) {
              const approaches = await window.winglog.navdataListApproaches(icao, null)
              update = update.fields.approachIdent
                ? matchClearanceApproach(update, approaches)
                : approachForArrivalRunway(update, approaches, procedureSelection)
            }
          } catch {
            // No list to check against: offer the clearance as parsed.
          }
        }
        if (!update) return
        const differs = Object.entries(update.fields).some(
          ([key, value]) => procedureSelection[key as keyof ProcedureSelection] !== value
        )
        if (differs) setPendingAtcClearance({ ...update, sourceTs: candidate.sourceTs })
      })()
    })
  }, [procedureSelection])

  function handleAcceptAtcClearance(): void {
    if (!pendingAtcClearance) return
    setProcedureSelection((prev) => ({ ...prev, ...pendingAtcClearance.fields }))
    setPendingAtcClearance(null)
  }

  function handleDismissAtcClearance(): void {
    setPendingAtcClearance(null)
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
    if (targetPage !== effectivePage) {
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
      void loadGsxRemoteView()
      void loadBeyondAtcView()
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
    window.winglog.settingsGetMapLanguage().then(setMapLanguage)
    window.winglog.settingsGetLandingDistanceUnit().then(setLandingDistanceUnit)
    window.winglog.settingsGetTheme().then(setTheme)
    window.winglog.settingsGetGsxRemote().then((settings) => setGsxRemoteEnabled(settings.enabled))
    window.winglog.settingsGetBeyondAtc().then((settings) => setBeyondAtcEnabled(settings.enabled))
    Promise.all([window.winglog.settingsGetAppLanguage(), window.winglog.settingsGetSystemLocale()]).then(
      ([saved, systemLocale]) => {
        setAppLanguage(saved)
        void i18n.changeLanguage(resolveAppLanguage(saved, systemLocale))
      }
    )
  }, [])

  // Disabling the tab you're currently viewing (from Settings, in the same window) shouldn't
  // strand you on a now-hidden page — derived during render rather than an effect calling
  // setPage, per this project's own "don't setState-in-effect what you can compute" rule
  // (flightdeck-backend's docs/decisions.md, the GSX command-bar SimBrief-loading fix).
  const effectivePage: AppPage =
    (page === 'gsx' && !gsxRemoteEnabled) || (page === 'beyondatc' && !beyondAtcEnabled) ? 'fleet' : page

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

  // First-launch setup (flightdeck-backend's docs/plans/first-launch-setup.md): shown to a new
  // install; someone upgrading with a fleet or logbook gets a one-off "what's new" instead.
  const [setupOpen, setSetupOpen] = useState(false)
  useEffect(() => {
    window.winglog.setupGetState().then(async (setup) => {
      if (setup.show) setSetupOpen(true)
      if (setup.whatsNew) toast.info(i18n.t('app.whatsNew'), { duration: 15_000 })
      // A no-op (returns null) on every launch after the app's actual first-ever one —
      // see settingsCheckGsxFirstLaunch's doc comment.
      const result = await window.winglog.settingsCheckGsxFirstLaunch()
      // The setup's add-ons step shows what this found, so no separate toast on top of it.
      if (!result || setup.show) return
      // i18n.t directly, not the hook's t — this only runs once at mount (checking a
      // one-time flag), so it must not depend on a value that changes on every language
      // switch just to satisfy the exhaustive-deps rule.
      if (result.found) {
        toast.success(i18n.t('app.gsxFirstLaunch.found'))
      } else {
        toast.info(i18n.t('app.gsxFirstLaunch.notFound'))
      }
    })
  }, [])

  useEffect(() => {
    return window.winglog.onGsxRemoteMenu(setGsxMenu)
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

  async function handleMapLanguageChange(language: MapLanguage): Promise<void> {
    setMapLanguage(language)
    await window.winglog.settingsSetMapLanguage(language)
  }

  async function handleAppLanguageChange(language: AppLanguage): Promise<void> {
    setAppLanguage(language)
    await window.winglog.settingsSetAppLanguage(language)
    const systemLocale = await window.winglog.settingsGetSystemLocale()
    void i18n.changeLanguage(resolveAppLanguage(language, systemLocale))
  }

  async function handleWindSpeedUnitChange(unit: WindSpeedUnit): Promise<void> {
    setWindSpeedUnit(unit)
    await window.winglog.settingsSetWindSpeedUnit(unit)
  }

  async function handleLandingDistanceUnitChange(unit: LandingDistanceUnit): Promise<void> {
    setLandingDistanceUnit(unit)
    await window.winglog.settingsSetLandingDistanceUnit(unit)
  }

  return (
    <main className="flex h-screen flex-col">
      <UpdateBanner airborne={telemetry !== null && !telemetry.onGround} />
      <Tabs value={effectivePage} onValueChange={(value) => setPage(value as AppPage)} className="min-h-0 flex-1 gap-0">
        {/* Narrow windows (a second monitor, and later a tablet or phone): tabs drop to icons
            below lg, keeping each label for screen readers, and scroll if they still don't fit. */}
        <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3 sm:gap-4 sm:px-6">
          <TabsList variant="line" className="min-w-0 justify-start overflow-x-auto overflow-y-hidden [scrollbar-width:none]">
            {appTabs(t, gsxRemoteEnabled, beyondAtcEnabled).map(({ page: tabPage, label, icon: Icon }) => (
              <TabsTrigger
                key={tabPage}
                value={tabPage}
                className="gap-1.5 px-1.5 sm:px-3"
                aria-label={label}
                onClick={() => goToTab(tabPage)}
              >
                <Icon />
                {/* Hidden below lg; the tab keeps its name through aria-label. Not sr-only/lg:not-sr-only:
                    not-sr-only resets white-space, which wrapped "Ground services" under the underline. */}
                <span className="hidden lg:inline">{label}</span>
              </TabsTrigger>
            ))}
          </TabsList>
          <Badge variant={connectionStatusVariant(simStatus)} title={connectionStatusLabel(simStatus, t)} className="shrink-0">
            <span className="sm:hidden">{connectionStateLabel(simStatus, t)}</span>
            <span className="hidden sm:inline">{t('app.connection.badge', { state: connectionStateLabel(simStatus, t) })}</span>
          </Badge>
        </header>

        {/* min-h-0 overrides the flex-item default of min-height:auto — without it, a
            tall page (e.g. Logbook's full flight list) forces this div past its 100vh
            budget instead of clipping to it, and the whole document scrolls (dragging
            the header above away with it) instead of just this div
            (flight-test-findings-2026-09-06.md #7 — confirmed live: the outer <main> was
            measurably taller than the viewport, not this div). */}
        <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-8">
          {effectivePage === 'fleet' && (
            <FleetView
              onOpenFlightInLogbook={openFlightInLogbook}
              initialAircraftId={pendingFleetAircraftId}
              onInitialAircraftConsumed={() => setPendingFleetAircraftId(null)}
              resetSignal={fleetResetSignal}
            />
          )}
          <Suspense fallback={<PageSkeleton />}>
            {effectivePage === 'dispatch' && (
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
            {effectivePage === 'track' && (
              <TrackView
                windSpeedUnit={windSpeedUnit}
                previewOfp={dispatchOfp}
                telemetry={telemetry}
                mapLanguage={mapLanguage}
                selection={procedureSelection}
                onSelectionChange={setProcedureSelection}
                onFlightEnded={handleFlightEnded}
              />
            )}
            {effectivePage === 'gsx' && <GsxRemoteView />}
            {effectivePage === 'beyondatc' && <BeyondAtcView />}
            {effectivePage === 'logbook' && (
              <LogbookView
                weightUnit={weightUnit}
                landingDistanceUnit={landingDistanceUnit}
                mapLanguage={mapLanguage}
                initialFlightId={pendingLogbookFlight?.flightId ?? null}
                initialFlightOriginAircraftId={pendingLogbookFlight?.fromAircraftId ?? null}
                onInitialFlightConsumed={() => setPendingLogbookFlight(null)}
                onBackToAircraft={openFleetAircraft}
                resetSignal={logbookResetSignal}
              />
            )}
            {effectivePage === 'settings' && (
              <SettingsView
                weightUnit={weightUnit}
                onWeightUnitChange={handleWeightUnitChange}
                altitudeUnit={altitudeUnit}
                onAltitudeUnitChange={handleAltitudeUnitChange}
                windSpeedUnit={windSpeedUnit}
                onWindSpeedUnitChange={handleWindSpeedUnitChange}
                landingDistanceUnit={landingDistanceUnit}
                onLandingDistanceUnitChange={handleLandingDistanceUnitChange}
                mapLanguage={mapLanguage}
                onMapLanguageChange={handleMapLanguageChange}
                appLanguage={appLanguage}
                onAppLanguageChange={handleAppLanguageChange}
                theme={theme}
                onThemeChange={handleThemeChange}
                onGsxRemoteEnabledChange={setGsxRemoteEnabled}
                onBeyondAtcEnabledChange={setBeyondAtcEnabled}
                onRunSetup={() => setSetupOpen(true)}
                resetSignal={settingsResetSignal}
              />
            )}
          </Suspense>
        </div>
      </Tabs>
      <Toaster />
      <SetupDialog
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
        weightUnit={weightUnit}
        onWeightUnitChange={handleWeightUnitChange}
        altitudeUnit={altitudeUnit}
        onAltitudeUnitChange={handleAltitudeUnitChange}
        windSpeedUnit={windSpeedUnit}
        onWindSpeedUnitChange={handleWindSpeedUnitChange}
        landingDistanceUnit={landingDistanceUnit}
        onLandingDistanceUnitChange={handleLandingDistanceUnitChange}
        mapLanguage={mapLanguage}
        onMapLanguageChange={handleMapLanguageChange}
        appLanguage={appLanguage}
        onAppLanguageChange={handleAppLanguageChange}
        onGsxRemoteEnabledChange={setGsxRemoteEnabled}
        onBeyondAtcEnabledChange={setBeyondAtcEnabled}
      />

      <AlertDialog open={orphanedFlight !== null} onOpenChange={(open) => !open && setOrphanedFlight(null)}>
        <AlertDialogContent>
          {orphanedFlight && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{orphanedFlightCopy(orphanedFlight, t).title}</AlertDialogTitle>
                <AlertDialogDescription>{orphanedFlightCopy(orphanedFlight, t).description}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={handleDiscardOrphaned}>
                  {t('app.orphanedFlight.discard')}
                </AlertDialogCancel>
                <AlertDialogAction onClick={handleResumeOrphaned}>
                  {orphanedFlightCopy(orphanedFlight, t).confirmLabel}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>

      {(() => {
        const important = gsxMenu !== null && isImportantGsxMenu(gsxMenu)
        const menuKey = gsxMenu && important ? gsxMenuSignature(gsxMenu) : null
        const open = effectivePage !== 'gsx' && menuKey !== null && menuKey !== dismissedGsxMenuKey
        return (
          <Dialog open={open} onOpenChange={(next) => !next && menuKey && setDismissedGsxMenuKey(menuKey)}>
            <DialogContent className="sm:max-w-md">
              {gsxMenu && (
                <>
                  <DialogHeader>
                    <DialogTitle>{t('app.gsxImportantPrompt.title')}</DialogTitle>
                  </DialogHeader>
                  {/* GSX's own text, verbatim — not translated, same convention as
                      SimBrief-sourced data (third-party content, not ours to translate). */}
                  <p className="text-sm font-medium text-foreground">{gsxMenu.title || gsxMenu.header}</p>
                  <div className="flex flex-col gap-1.5">
                    {gsxMenu.entries.map((entry, index) => (
                      <Button
                        key={`${index}-${entry}`}
                        type="button"
                        variant="outline"
                        disabled={gsxMenu.disabled[index] === true}
                        className="h-auto whitespace-normal py-2 text-left justify-start"
                        onClick={() => handlePickGsxMenu(index)}
                      >
                        {entry}
                      </Button>
                    ))}
                  </div>
                </>
              )}
            </DialogContent>
          </Dialog>
        )
      })()}

      <Dialog open={pendingAtcClearance !== null} onOpenChange={(open) => !open && handleDismissAtcClearance()}>
        <DialogContent className="sm:max-w-md">
          {pendingAtcClearance && (
            <>
              <DialogHeader>
                <DialogTitle>{t('app.atcClearancePrompt.title')}</DialogTitle>
              </DialogHeader>
              <div className="flex flex-col gap-1.5 text-sm">
                {Object.entries(pendingAtcClearance.fields).map(([key, value]) => (
                  <p key={key}>
                    <span className="font-medium text-foreground">
                      {t(ATC_CLEARANCE_FIELD_LABEL_KEYS[key as keyof ProcedureSelection] ?? '')}:{' '}
                    </span>
                    <span className="text-muted-foreground">
                      {procedureSelection[key as keyof ProcedureSelection] ?? t('procedureSelector.none')}
                    </span>
                    {' → '}
                    <span className="text-foreground">{value ?? t('procedureSelector.none')}</span>
                  </p>
                ))}
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={handleDismissAtcClearance}>
                  {t('app.atcClearancePrompt.dismiss')}
                </Button>
                <Button type="button" onClick={handleAcceptAtcClearance}>
                  {t('app.atcClearancePrompt.update')}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </main>
  )
}
