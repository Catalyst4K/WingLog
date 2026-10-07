/**
 * The app shell's state, one hook per concern: the dispatched flight plan,
 * an unfinished flight from a previous run, BeyondATC clearances, GSX's important menus,
 * navigation between tabs, the sim connection, and first-launch setup. The display settings
 * are in use-display-settings.ts.
 */

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type {
  AppPage,
  BeyondAtcState,
  DispatchOfp,
  Flight,
  GsxRemoteMenuState,
  ProcedureSelection,
  SimConnectionStatus,
  SimTelemetry
} from '@shared/ipc'
import { parseAtcBoxClearance } from '@shared/atc-info-boxes'
import { gsxMenuSignature, isImportantGsxMenu } from '../gsx-remote-importance'
import i18n from '../i18n'
import {
  emptyProcedureSelection,
  seedProcedureSelectionFromOfp,
  selectionFromFlight
} from '../procedureSelection'
import { runAsync } from '../report-error'
import { resolveAtcClearance, type PendingAtcClearance } from './atc-clearance'

/** The dispatched OFP and procedure selection Dispatch and Track share, and their handlers. */
export interface FlightPlan {
  dispatchOfp: DispatchOfp | null
  /** The ofpId of the OFP that's already been turned into a flight. */
  dispatchedOfpId: string | null
  setDispatchedOfpId: (ofpId: string | null) => void
  procedureSelection: ProcedureSelection
  setProcedureSelection: React.Dispatch<React.SetStateAction<ProcedureSelection>>
  /** Sets the OFP, re-seeding the selection when it's a different one. */
  onDispatchOfpChange: (ofp: DispatchOfp | null) => void
  /** Clears Dispatch's view once a flight stops being current. */
  onFlightEnded: () => void
}

/**
 * The flight plan lifted out of Dispatch and Track: the fetched OFP, which one has been flown,
 * and the live procedure selection. Restored after a restart from the flight in progress, and
 * cleared when tracking auto-completes on whatever tab the user is on.
 *
 * @returns The plan and its handlers.
 */
export function useFlightPlan(): FlightPlan {
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
  // choice whenever a genuinely new OFP loads — see onDispatchOfpChange below.
  const [procedureSelection, setProcedureSelection] = useState<ProcedureSelection>(emptyProcedureSelection())

  // Wraps setDispatchOfp so a *new* OFP (a different ofpId, including "cleared to null")
  // always re-seeds the procedure selection from its own SimBrief choice — the previous
  // plan's selection must never leak onto a different one. Re-fetching/re-saving the exact
  // same OFP the user's already been editing (ofpId unchanged) leaves the selection alone,
  // or every dropdown edit would be wiped out from under them.
  function onDispatchOfpChange(ofp: DispatchOfp | null): void {
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
  function onFlightEnded(): void {
    onDispatchOfpChange(null)
    setDispatchedOfpId(null)
  }

  // Kept in sync with the latest onFlightEnded closure on every render (same pattern as
  // TrackView's own onFlightEndedRef) so the mount-once subscription below never calls back
  // into a stale `dispatchOfp` from whatever render happened to be current when it first
  // subscribed.
  const onFlightEndedRef = useRef(onFlightEnded)
  useEffect(() => {
    onFlightEndedRef.current = onFlightEnded
  })

  // A flight can auto-complete (shutdown detection) while the user is on any tab, not just
  // Track — TrackView's own onTrackingPoint subscription only exists while it's mounted, so
  // relying on that alone left Dispatch showing a finished flight's OFP/route indefinitely
  // whenever Track wasn't open at the moment shutdown fired (real report, 2026-09-27).
  // Subscribed here instead, at the top level, so it fires no matter what's currently on
  // screen.
  useEffect(() => {
    return window.winglog.onTrackingPoint((point) => {
      if (point.phase === 'shutdown') onFlightEndedRef.current()
    })
  }, [])

  // Restores Dispatch's own view of whatever flight is currently "in progress" (planned
  // or already active) after a restart — its own dispatchOfp/dispatchedOfpId are
  // renderer-only state that don't survive one, unlike Track's flight list, which reads
  // the DB directly and was never the problem. Uses the raw setters, not
  // onDispatchOfpChange, so this doesn't also re-seed procedureSelection from
  // SimBrief's own choice — selectionFromFlight below already restores whatever was last
  // actually chosen (SimBrief's plan if nothing was ever touched, a live edit otherwise —
  // see handleSaveFlight, which persists props.selection at the moment Fly is pressed).
  useEffect(() => {
    runAsync(
      'App dispatchGetInProgressFlight',
      window.winglog.dispatchGetInProgressFlight().then((result) => {
        if (!result) return
        setDispatchOfp(result.ofp)
        setDispatchedOfpId(result.ofp.ofpId)
        setProcedureSelection(selectionFromFlight(result.flight))
      })
    )
  }, [])

  return {
    dispatchOfp,
    dispatchedOfpId,
    setDispatchedOfpId,
    procedureSelection,
    setProcedureSelection,
    onDispatchOfpChange,
    onFlightEnded
  }
}

/**
 * The one flight left "in progress" (planned or already active) by a previous process —
 * either a genuine crash/quit mid-track, or just Fly pressed and never followed through
 * (no crash at all, tracking simply never started). Its own DB row (OFP, route,
 * everything Dispatch/Track need) was never at risk either way, only TrackingController's
 * in-memory phase-detection state, which only exists once a flight reaches 'active'.
 * Neither resuming nor continuing is automatic — only the user can judge whether it's
 * still relevant — so this drives a one-time prompt instead, checked once at startup.
 *
 * @param plan The flight plan, which resuming or discarding updates.
 * @param onResumed Called after the flight is resumed, to show Track.
 * @returns The flight (null when there's none or it's been answered), and the prompt's handlers.
 */
export function useOrphanedFlight(
  plan: FlightPlan,
  onResumed: () => void
): {
  orphanedFlight: Flight | null
  onClose: () => void
  onResume: () => Promise<void>
  onDiscard: () => Promise<void>
} {
  const [orphanedFlight, setOrphanedFlight] = useState<Flight | null>(null)
  useEffect(() => {
    runAsync(
      'App trackingGetOrphanedFlight',
      window.winglog.trackingGetOrphanedFlight().then(setOrphanedFlight)
    )
  }, [])

  return {
    orphanedFlight,
    onClose: () => setOrphanedFlight(null),
    onResume: async () => {
      if (!orphanedFlight) return
      await window.winglog.trackingResumeOrphaned(orphanedFlight.id)
      // The flight's own persisted selection (whatever was last chosen before the crash),
      // not a blank one — matches how a completed flight's Logbook map reads its selection
      // back (selectionFromFlight), just resuming instead of reviewing.
      plan.setProcedureSelection(selectionFromFlight(orphanedFlight))
      onResumed()
      setOrphanedFlight(null)
    },
    onDiscard: async () => {
      if (!orphanedFlight) return
      await window.winglog.trackingDiscardOrphaned(orphanedFlight.id)
      // The dispatch-hydration effect may have already restored Dispatch's view of this
      // exact flight (it runs independently, before the user gets a chance to answer this
      // prompt) — clear it back out rather than leaving Dispatch showing a "Flying" badge
      // for a flight that's now abandoned.
      if (orphanedFlight.ofpId && orphanedFlight.ofpId === plan.dispatchOfp?.ofpId) {
        plan.onDispatchOfpChange(null)
        plan.setDispatchedOfpId(null)
      }
      setOrphanedFlight(null)
    }
  }
}

/**
 * Reads each new set of BeyondATC InfoBoxes for a clearance whose fields differ from the
 * current selection, and holds it for the user's accept or dismiss — Callum's own precedence
 * decision, 2026-09-25: overwrite, but ask first, gently. Never ATC's speech
 * (winglog-backend's docs/decisions.md, 2026-10-05). Re-subscribes whenever the selection
 * changes so a diff is always checked against the live value, the same "just resubscribe,
 * it's cheap" style procedureSelection.ts's own fetch effects already use.
 *
 * @param selection The current procedure selection.
 * @param setSelection Applies an accepted clearance.
 * @returns The clearance awaiting an answer, and the accept and dismiss handlers.
 */
export function useAtcClearancePrompt(
  selection: ProcedureSelection,
  setSelection: React.Dispatch<React.SetStateAction<ProcedureSelection>>
): { pending: PendingAtcClearance | null; onAccept: () => void; onDismiss: () => void } {
  // Unlike the GSX prompt, no remembered-dismissal key is needed: each new set of InfoBoxes
  // is read once (lastAtcBoxesKey below), not re-offered while it stays up.
  const [pending, setPending] = useState<PendingAtcClearance | null>(null)
  // The last set of BeyondATC InfoBoxes already read: the state is pushed on every BeyondATC
  // message, so this tells a genuinely new set apart from one already considered (and
  // possibly dismissed).
  const lastAtcBoxesKey = useRef('')

  useEffect(() => {
    return window.winglog.onBeyondAtcState((state: BeyondAtcState) => {
      const key = JSON.stringify(state.infoBoxes)
      if (key === lastAtcBoxesKey.current) return
      lastAtcBoxesKey.current = key
      const update = parseAtcBoxClearance(state.infoBoxes)
      if (!update) return
      void resolveAtcClearance({ ...update, sourceTs: state.infoBoxesAt ?? Date.now() }, selection).then(
        (offer) => {
          if (offer) setPending(offer)
        }
      )
    })
  }, [selection])

  return {
    pending,
    onAccept: () => {
      if (!pending) return
      setSelection((prev) => ({ ...prev, ...pending.fields }))
      setPending(null)
    },
    onDismiss: () => setPending(null)
  }
}

/**
 * GSX's live menu, tracked at the top level (not just inside GsxRemoteView) so an "important"
 * one — pushback direction, fuel amount, Callum's explicit call, 2026-09-21 — can interrupt
 * wherever the user currently is, not just when they happen to be on the GSX tab. Everything
 * else GSX might ask stays confined to that tab, unflagged, resolved by GSX's own
 * default/timeout if nobody answers there (winglog-backend's docs/gsx-notes.md).
 *
 * @param onGsxTab Whether the GSX tab is showing, where the menu is answered in place.
 * @returns The menu, whether the global prompt is open, and its dismiss handler.
 */
export function useImportantGsxMenu(onGsxTab: boolean): {
  menu: GsxRemoteMenuState | null
  open: boolean
  onDismiss: () => void
} {
  const [menu, setMenu] = useState<GsxRemoteMenuState | null>(null)
  // Remembers which exact menu the user dismissed without answering, so closing the global
  // prompt doesn't just reopen itself on the next unrelated re-render — only a genuinely
  // different menu (a new signature) triggers it again.
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)
  useEffect(() => {
    return window.winglog.onGsxRemoteMenu(setMenu)
  }, [])

  const important = menu !== null && isImportantGsxMenu(menu)
  const menuKey = menu && important ? gsxMenuSignature(menu) : null
  return {
    menu,
    open: !onGsxTab && menuKey !== null && menuKey !== dismissedKey,
    onDismiss: () => {
      if (menuKey) setDismissedKey(menuKey)
    }
  }
}

/** Which tab is showing, the cross-tab hand-offs, and the handlers that navigate. */
export interface Navigation {
  /** The tab showing — the chosen one, or Fleet when the chosen tab has since been hidden. */
  effectivePage: AppPage
  setPage: (page: AppPage) => void
  /** A flight Fleet asked Logbook to open, with the aircraft it came from. */
  pendingLogbookFlight: { flightId: number; fromAircraftId: number } | null
  clearPendingLogbookFlight: () => void
  /** An aircraft Logbook's "Back" asked Fleet to open. */
  pendingFleetAircraftId: number | null
  clearPendingFleetAircraftId: () => void
  fleetResetSignal: number
  logbookResetSignal: number
  settingsResetSignal: number
  goToTab: (page: AppPage) => void
  openFlightInLogbook: (flightId: number, fromAircraftId: number) => void
  openFleetAircraft: (aircraftId: number) => void
}

/**
 * Tab navigation, including the Fleet ↔ Logbook hand-offs and the "return to your default
 * view" signal a click on the active tab sends.
 *
 * @param gsxRemoteEnabled Whether the GSX tab exists.
 * @param beyondAtcEnabled Whether the BeyondATC tab exists.
 * @returns The navigation state and handlers.
 */
export function useNavigation(gsxRemoteEnabled: boolean, beyondAtcEnabled: boolean): Navigation {
  const [page, setPage] = useState<AppPage>('fleet')
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

  // Disabling the tab you're currently viewing (from Settings, in the same window) shouldn't
  // strand you on a now-hidden page — derived during render rather than an effect calling
  // setPage, per this project's own "don't setState-in-effect what you can compute" rule
  // (winglog-backend's docs/decisions.md, the GSX command-bar SimBrief-loading fix).
  const effectivePage: AppPage =
    (page === 'gsx' && !gsxRemoteEnabled) || (page === 'beyondatc' && !beyondAtcEnabled) ? 'fleet' : page

  /**
   * Always navigates to `targetPage` — including "return to its default view" when
   * already there, which a bare `setPage` can't do (Radix's Tabs only fires
   * `onValueChange` on an actual value change, so clicking the active tab is normally a
   * no-op). Dispatch and Track are deliberate exceptions: their lifted state
   * (`dispatchOfp`/`dispatchedOfpId`, Track's own in-progress tracking) is work in
   * progress, not navigation history — clearing it because the user clicked the tab
   * they're already on would be a data-loss bug wearing a UX fix's clothing.
   *
   * @param targetPage The tab clicked.
   */
  function goToTab(targetPage: AppPage): void {
    if (targetPage !== effectivePage) {
      setPage(targetPage)
      return
    }
    if (targetPage === 'fleet') setFleetResetSignal((n) => n + 1)
    if (targetPage === 'logbook') setLogbookResetSignal((n) => n + 1)
    if (targetPage === 'settings') setSettingsResetSignal((n) => n + 1)
  }

  return {
    effectivePage,
    setPage,
    pendingLogbookFlight,
    clearPendingLogbookFlight: () => setPendingLogbookFlight(null),
    pendingFleetAircraftId,
    clearPendingFleetAircraftId: () => setPendingFleetAircraftId(null),
    fleetResetSignal,
    logbookResetSignal,
    settingsResetSignal,
    goToTab,
    openFlightInLogbook: (flightId, fromAircraftId) => {
      setPendingLogbookFlight({ flightId, fromAircraftId })
      setPage('logbook')
    },
    openFleetAircraft: (aircraftId) => {
      setPendingFleetAircraftId(aircraftId)
      setPage('fleet')
    }
  }
}

/**
 * The sim connection's status and its latest telemetry.
 *
 * @returns The status, and the telemetry (null while not connected).
 */
export function useSimConnection(): { simStatus: SimConnectionStatus; telemetry: SimTelemetry | null } {
  const [simStatus, setSimStatus] = useState<SimConnectionStatus>({ state: 'disconnected' })
  const [telemetry, setTelemetry] = useState<SimTelemetry | null>(null)
  useEffect(() => {
    // Pull current status in case the initial connect (main process starts it immediately
    // on app launch) already resolved before this component mounted — the push channel
    // below only delivers *future* changes, Electron doesn't replay missed IPC sends.
    runAsync('App getSimConnectionStatus', window.winglog.getSimConnectionStatus().then(setSimStatus))
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
  return { simStatus, telemetry }
}

/**
 * First-launch setup (winglog-backend's docs/plans/first-launch-setup.md): shown to a new
 * install; someone upgrading with a fleet or logbook gets a one-off "what's new" instead.
 * Also reports, once, whether GSX was found on the app's first-ever launch.
 *
 * @returns Whether the setup dialog is open, and its setter.
 */
export function useFirstLaunchSetup(): { setupOpen: boolean; setSetupOpen: (open: boolean) => void } {
  const [setupOpen, setSetupOpen] = useState(false)
  useEffect(() => {
    runAsync(
      'App setupGetState',
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
    )
  }, [])
  return { setupOpen, setSetupOpen }
}
