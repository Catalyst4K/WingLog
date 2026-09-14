import { EventEmitter } from 'node:events'
import type { ActiveTracking, FlightPhase, ProcedureSelection, TrackPoint } from '@shared/ipc'
import type { WingLogDb } from '../db/client'
import { addInvoicesForFlight } from '../db/flight-invoice-repo'
import {
  abandonFlight,
  completeFlight,
  finalizeFuelOut,
  getFlight,
  type PausedInterval,
  recordOff,
  recordOn,
  setFlownRoute,
  setSelectedProcedures,
  startFlight
} from '../db/flight-repo'
import { createLanding } from '../db/landing-repo'
import { getGsxSettings } from '../db/settings-repo'
import { createTrackPoint, listTrackPoints } from '../db/track-point-repo'
import { buildFlightMatchWindow } from '../gsx/flight-window'
import { scanGsxFolder } from '../gsx/scan'
import type { SimConnectSource } from '../sim/SimConnectSource'
import { FlightRecorder } from './FlightRecorder'
import { buildLandingRecord } from './landing-capture'
import { isPhysicallyImpossibleJump, RESUME_CLEANUP_CONSTANTS, type TrackCleanupResult } from './resume-cleanup'
import { runTrackCleanupForFlight } from './run-track-cleanup'
import { deriveFlownRouteJson } from './route-simplify'

interface TrackingControllerEvents {
  point: [TrackPoint]
  /** Emitted whenever a resume-cleanup pass (resume-cleanup.ts) actually changes something
   *  — a point newly excluded, or retagged with a new resumeSegment — carrying every
   *  affected point at its now-current values, so a live map (already holding the earlier,
   *  since-corrected copies pushed via 'point') can patch them in place rather than wait
   *  for flight completion to see the trail redraw correctly. */
  pointsUpdated: [TrackPoint[]]
  /** Emitted whenever a flight reaches 'completed' — auto shutdown detection or a manual
   *  finish() alike — so main/index.ts can trigger a background cloud sync
   *  (flightdeck-backend/docs/plans/cloud-sync-v2.md #3) without this class needing to
   *  know anything about sync itself. */
  completed: [number]
}

/**
 * Bridges live SimConnectService telemetry to FlightRecorder's phase detection and
 * persistence — one flight tracked at a time, matching the app's single-window,
 * single-active-flight model. Subscribes to SimConnectService once at construction and
 * stays subscribed regardless of whether a flight is currently being tracked, so start()
 * doesn't race a telemetry tick that arrived just before it.
 *
 * Constructor takes a SimConnectSource, not the concrete SimConnectService class — the
 * structural interface both SimConnectService and ReplaySimConnectService satisfy, per
 * flightdeck-backend's docs/plans/flight-replay-harness.md Phase 3. main/index.ts is the
 * only place that decides which concrete implementation gets constructed.
 */
export class TrackingController extends EventEmitter<TrackingControllerEvents> {
  private recorder: FlightRecorder | undefined
  private offRecorded = false
  private onRecorded = false
  private fuelOutFinalized = false
  // Pushed live from the renderer (setProcedureSelection) while a flight is being tracked —
  // cached here, not written to the DB until completion, since neither completion trigger
  // below (auto shutdown detection or a manual finish()) round-trips through the renderer
  // to ask it what's currently selected (docs/plans/navdata-without-navigraph.md, Phase 5).
  private currentSelection: ProcedureSelection | undefined
  // Real wall-clock spans the sim reported itself paused this session — used to keep
  // completeFlight's block/air-time stats from counting time the aircraft wasn't actually
  // going anywhere (see flight-repo.ts's own completeFlight comment). In-memory only, same
  // as offRecorded/onRecorded/fuelOutFinalized above: a pause that happened before an
  // app/process restart can't be recovered here, which is fine — that's a full resume, a
  // different scenario (flightdeck-backend's docs/plans/done/resume-track-cleanup.md), not an
  // in-session pause.
  private pausedIntervals: PausedInterval[] = []
  private openPauseStartIso: string | undefined
  // Live-jump detection for resume-cleanup.ts's Phase 2 (flightdeck-backend's docs/plans/
  // resume-track-cleanup.md) — cheap, incremental, and separate from the full pass run at
  // completion: lastPersistedPoint lets each new sample be checked against just its one
  // predecessor (Rule 2 is a per-pair test) without re-scanning the whole flight on every
  // tick. resumeWindowDeadlineMs is only used to know when a window has timed out with
  // nothing resolving it (Case C) — the jump check itself runs unconditionally either way,
  // per the design decided 2026-09-13 (see resume-cleanup.ts's own doc comment).
  private lastPersistedPoint: TrackPoint | undefined
  private resumeWindowDeadlineMs: number | undefined

  constructor(
    private readonly db: WingLogDb,
    private readonly simConnectService: SimConnectSource
  ) {
    super()
    this.simConnectService.on('telemetry', (telemetry) => {
      if (!this.recorder) return
      const result = this.recorder.ingest(telemetry, new Date())

      // The value startFlight wrote at tracking-start is only provisional (see
      // finalizeFuelOut's doc comment) — correct it as soon as the phase machine shows
      // the aircraft is genuinely past ground fuel service, not just parked.
      if (result.phase !== 'preflight' && !this.fuelOutFinalized) {
        this.fuelOutFinalized = true
        finalizeFuelOut(this.db, this.recorder.getFlightId(), telemetry.fuelTotalKg)
      }

      if (result.phase === 'climb' && !this.offRecorded) {
        this.offRecorded = true
        recordOff(this.db, this.recorder.getFlightId())
      }
      if (result.phase === 'landing' && !this.onRecorded) {
        this.onRecorded = true
        const flightId = this.recorder.getFlightId()
        recordOn(this.db, flightId)
        // Same tick, same on-ground false->true transition M6's own touchdown detection
        // targets (docs/decisions.md, landing-analysis entry) — the flight row is already
        // loaded here for its arr_icao, which narrows the runway lookup to one airport.
        const flight = getFlight(this.db, flightId)
        if (flight) {
          createLanding(this.db, buildLandingRecord(flightId, flight.arrIcao, telemetry, new Date().toISOString()))
        }
      }

      if (result.point) {
        const saved = createTrackPoint(this.db, result.point)
        this.emit('point', saved)
        this.checkForLiveJump(saved)
      }

      if (result.phase === 'shutdown') {
        const flightId = this.recorder.getFlightId()
        completeFlight(this.db, flightId, telemetry.fuelTotalKg, this.closedPauseIntervals())
        this.snapshotGsxInvoices(flightId)
        this.runTrackCleanup(flightId)
        this.deriveFlownRoute(flightId)
        this.persistSelection(flightId)
        this.recorder = undefined
        this.emit('completed', flightId)
      }
    })
    this.simConnectService.on('paused', (paused) => {
      this.recorder?.setPaused(paused)
      if (!this.recorder) return
      const nowIso = new Date().toISOString()
      if (paused) {
        this.openPauseStartIso ??= nowIso
      } else if (this.openPauseStartIso) {
        this.pausedIntervals.push({ startIso: this.openPauseStartIso, endIso: nowIso })
        this.openPauseStartIso = undefined
      }
    })
  }

  /** `pausedIntervals` plus whatever pause is still open at completion time (the user can
   *  hit "Finish now" while paused) — closed off at "now" so it's still counted. */
  private closedPauseIntervals(): PausedInterval[] {
    if (!this.openPauseStartIso) return this.pausedIntervals
    return [...this.pausedIntervals, { startIso: this.openPauseStartIso, endIso: new Date().toISOString() }]
  }

  getActive(): ActiveTracking | undefined {
    return this.recorder
      ? { flightId: this.recorder.getFlightId(), phase: this.recorder.getPhase() }
      : undefined
  }

  start(flightId: number): void {
    if (this.recorder) throw new Error(`Already tracking flight ${this.recorder.getFlightId()}`)
    if (!getFlight(this.db, flightId)) throw new Error(`Flight ${flightId} not found`)

    const telemetry = this.simConnectService.getLastTelemetry()
    if (!telemetry) throw new Error('Not connected to the sim')

    startFlight(this.db, flightId, telemetry.fuelTotalKg)
    this.recorder = new FlightRecorder(flightId)
    this.offRecorded = false
    this.onRecorded = false
    this.fuelOutFinalized = false
    // A stale selection from whatever flight was tracked previously must never leak onto
    // this one — start with nothing cached; createFlight's own saved-at-plan-time values
    // (if any) are untouched until/unless this flight's own selection gets pushed.
    this.currentSelection = undefined
    this.pausedIntervals = []
    this.openPauseStartIso = undefined
    this.lastPersistedPoint = undefined
    this.resumeWindowDeadlineMs = undefined
  }

  /**
   * Picks phase detection back up for a flight left 'active' by a previous process — the
   * app quit or crashed before shutdown detection (or a manual finish()) ever ran, so the
   * flight's own DB row (OFP, route, everything Track's map needs) was never at risk, only
   * this in-memory recorder was lost with the old process. Called once at startup
   * (main/index.ts) if the resume/discard prompt's flight (getInProgressFlight — 'planned'
   * or 'active') turns out to be 'active'; a safe no-op for a merely 'planned' one (there
   * was never a recorder tracking it to begin with) or if nothing's in progress at all.
   * Starting phase comes from the flight's last persisted track_point rather than
   * 'preflight', so an aircraft that's actually mid-air doesn't get stuck waiting for an
   * on-ground transition that will never come (see FlightRecorder's own resume-parameter
   * doc comment).
   */
  resume(flightId: number): void {
    const flight = getFlight(this.db, flightId)
    if (!flight || flight.status !== 'active') return

    const points = listTrackPoints(this.db, flightId)
    const lastPhase: FlightPhase = points.length ? points[points.length - 1].phase : 'preflight'
    // One more than whatever segment the flight was last recording in — 0 for a flight
    // resumed for the first time, incrementing further on a second/third resume in the
    // same flight (flightdeck-backend's docs/plans/done/resume-track-cleanup.md).
    const resumeSegment = points.length ? points[points.length - 1].resumeSegment + 1 : 0

    this.recorder = new FlightRecorder(flightId, {
      phase: lastPhase,
      hasLanded: flight.actualOnUtc != null,
      resumeSegment
    })
    this.offRecorded = flight.actualOffUtc != null
    this.onRecorded = flight.actualOnUtc != null
    this.fuelOutFinalized = this.offRecorded
    this.currentSelection = undefined
    this.pausedIntervals = []
    this.openPauseStartIso = undefined
    // Seeded with the anchor (the last point before this boundary) rather than left
    // undefined, so the very first live sample recorded after resuming — the sim's spawn
    // point — gets compared against it: a resumeSegment change with no jump test needed
    // (the boundary itself), opening the window checkForLiveJump's Case A/B logic resolves
    // inside (resume-cleanup.ts).
    this.lastPersistedPoint = points.length ? points[points.length - 1] : undefined
    this.resumeWindowDeadlineMs = Date.now() + RESUME_CLEANUP_CONSTANTS.RESUME_WINDOW_MS
  }

  /** Called from the renderer (tracking:set-procedure-selection) on every live selection
   *  change while a flight is being tracked — see the currentSelection field's own comment
   *  for why this can't just be read on demand at completion time. */
  setProcedureSelection(selection: ProcedureSelection): void {
    this.currentSelection = selection
  }

  /** User cancelled tracking mid-flight, rather than reaching shutdown naturally. */
  stop(): void {
    if (!this.recorder) return
    abandonFlight(this.db, this.recorder.getFlightId())
    this.recorder = undefined
  }

  /**
   * User manually ends and saves the flight now, rather than waiting for the phase
   * machine to reach 'shutdown' on its own — a safety net for cases where automatic
   * shutdown detection doesn't fire (e.g. the aircraft is left running, or the user just
   * wants to log what's been flown so far). Mirrors the phase === 'shutdown' completion
   * path above, using whatever fuel figure the sim last reported.
   */
  finish(): void {
    if (!this.recorder) return
    const flightId = this.recorder.getFlightId()
    const telemetry = this.simConnectService.getLastTelemetry()
    completeFlight(this.db, flightId, telemetry?.fuelTotalKg ?? 0, this.closedPauseIntervals())
    this.snapshotGsxInvoices(flightId)
    this.runTrackCleanup(flightId)
    this.deriveFlownRoute(flightId)
    this.persistSelection(flightId)
    this.recorder = undefined
    this.emit('completed', flightId)
  }

  /**
   * Incremental half of resume-cleanup.ts's Phase 2 — checked once per newly-persisted
   * sample against just its immediate predecessor (Rule 2 is a per-pair test, so this
   * never needs the whole flight's history to decide whether *this* pair looks like a
   * jump). A real jump either resolves an open resume window (Case A/B) or, per the
   * 2026-09-13 design decision, stands alone with none open at all (a payware aircraft's
   * own save-state/reload feature, confirmed live with no WingLog resume anywhere near
   * it) — either way `runTrackCleanup` below is the authoritative pass, cheap to run right
   * now since it's bounded to one flight's own points, not per-tick cost.
   */
  private checkForLiveJump(saved: TrackPoint): void {
    const previous = this.lastPersistedPoint
    this.lastPersistedPoint = saved
    if (this.resumeWindowDeadlineMs !== undefined && Date.now() > this.resumeWindowDeadlineMs) {
      // Case C: window timed out with nothing resolving it — real flying continuing on,
      // nothing more to do than the boundary Phase 1 already stamped.
      this.resumeWindowDeadlineMs = undefined
    }
    // No predecessor yet, or `saved` is itself a resume boundary (a fresh resumeSegment) —
    // neither is a pair Rule 2 evaluates; the boundary is exactly where a window opens
    // (already set up by resume() itself), not something to jump-test against.
    if (!previous || previous.resumeSegment !== saved.resumeSegment) return
    if (!isPhysicallyImpossibleJump(previous, saved)) return
    const result = this.runTrackCleanup(saved.flightId)
    this.resumeWindowDeadlineMs = undefined
    // A standalone jump (no resume window open) invents a new segment on the fly for
    // whatever tail already existed at the moment this ran — `saved` itself, since nothing
    // after it has been recorded yet. The recorder's own counter needs the same value, or
    // every point recorded from here on would keep stamping the now-stale original segment
    // instead of continuing the new one (FlightRecorder.bumpResumeSegment's own comment).
    const ownReassignment = result?.segmentReassignments.find((r) => r.id === saved.id)
    if (ownReassignment) this.recorder?.bumpResumeSegment(ownReassignment.resumeSegment)
  }

  /** Runs run-track-cleanup.ts's shared cleanup pass over this flight's full current
   *  history and persists whatever it finds — called both live (checkForLiveJump, right
   *  when a jump resolves something) and once more at completion as a backstop, matching
   *  the plan doc's own "when a resume window resolves … and once more at flight
   *  completion". The Logbook "Clean up track" button (main/index.ts) calls the same
   *  shared function directly for a flight with no active recorder at all — this method
   *  only adds the live-map-patching concern on top, which only matters while a flight is
   *  actively being tracked. A no-op write when nothing changed, and nothing is emitted in
   *  that case either — no already-drawn point needs correcting. Returns the raw result so
   *  a live caller can react to specifics (checkForLiveJump uses it to keep the recorder's
   *  own segment counter in step); undefined when nothing changed. */
  private runTrackCleanup(flightId: number): TrackCleanupResult | undefined {
    const result = runTrackCleanupForFlight(this.db, flightId)
    if (!result) return undefined
    const changedIds = new Set([
      ...result.exclusions.map((e) => e.id),
      ...result.segmentReassignments.map((r) => r.id)
    ])
    const updated = listTrackPoints(this.db, flightId).filter((p) => changedIds.has(p.id))
    this.emit('pointsUpdated', updated)
    return result
  }

  /**
   * Best-effort GSX receipt snapshot at flight completion (docs/decisions.md,
   * gsx-invoices entry) — a no-op when the integration is disabled/unconfigured, which is
   * the default and the common case on non-Windows machines. Fire-and-forget: a missing
   * folder, a renamed one, or a malformed receipt file must never take down flight
   * completion, which has already succeeded by the time this runs. The Logbook detail
   * page's manual "rescan" action covers anything this misses (e.g. a receipt GSX writes
   * slightly after this fires).
   */
  private snapshotGsxInvoices(flightId: number): void {
    const settings = getGsxSettings(this.db)
    if (!settings.enabled || !settings.folderPath) return
    const window = buildFlightMatchWindow(this.db, flightId)
    if (!window) return
    scanGsxFolder(settings.folderPath, window)
      .then((result) => addInvoicesForFlight(this.db, flightId, result.matched))
      .catch(() => {})
  }

  /** Derives and stores the flight's flown-route polyline (route-simplify.ts) at
   *  completion — same best-effort shape as the GSX snapshot above: reads back this
   *  flight's own already-persisted track_point rows, so a failure here can't affect the
   *  flight record, which is already marked completed by the time this runs. Synchronous
   *  (unlike the GSX scan, no I/O involved), so no .catch needed — a thrown error here
   *  would already be a real bug, not an expected "folder missing" case. */
  private deriveFlownRoute(flightId: number): void {
    // Called after runTrackCleanup above, so any junk this flight picked up is already
    // flagged — excluded here the same way the map filters it (flightdeck-backend's
    // docs/plans/done/resume-track-cleanup.md), so a crash-resume triangle or a mid-flight
    // teleport never gets baked into the synced flown-route polyline.
    const points = listTrackPoints(this.db, flightId).filter((p) => p.excludedReason == null)
    const flownRouteJson = deriveFlownRouteJson(points)
    if (flownRouteJson) setFlownRoute(this.db, flightId, flownRouteJson)
  }

  /** Writes whatever selection the renderer last pushed — a no-op if nothing ever was
   *  (e.g. tracking a flight from before Phase 5, or Track was never opened this session),
   *  which leaves createFlight's own saved-at-plan-time values in place rather than
   *  clobbering them with nulls. */
  private persistSelection(flightId: number): void {
    if (!this.currentSelection) return
    setSelectedProcedures(this.db, flightId, this.currentSelection)
  }
}
