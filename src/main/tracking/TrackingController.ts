import { EventEmitter } from 'node:events'
import type { ActiveTracking, FlightPhase, ProcedureSelection, SimTelemetry, TrackPoint } from '@shared/ipc'
import { nearestAirport } from '../airports/airport-search'
import type { WingLogDb } from '../db/client'
import { addInvoicesForFlight } from '../db/flight-invoice-repo'
import {
  abandonFlight,
  completeFlight,
  createFreeFlight,
  finalizeFuelOut,
  getFlight,
  type PausedInterval,
  recordOff,
  recordOn,
  setArrIcao,
  setFlownRoute,
  setSelectedProcedures,
  startFlight
} from '../db/flight-repo'
import { createLanding, listLandingsByFlight } from '../db/landing-repo'
import type { SimAirfieldMatch } from '../airports/sim-airfield'
import { getGsxSettings, rememberAircraftForTitle } from '../db/settings-repo'
import { createTrackPoint, listTrackPoints } from '../db/track-point-repo'
import { buildFlightMatchWindow } from '../gsx/flight-window'
import { scanGsxFolder } from '../gsx/scan'
import type { SimConnectSource } from '../sim/SimConnectSource'
import { FlightRecorder } from './FlightRecorder'
import { seedPhaseFromTelemetry } from './free-flight'
import { buildLandingRecord } from './landing-capture'
import { isPhysicallyImpossibleJump, RESUME_CLEANUP_CONSTANTS, type TrackCleanupResult } from './resume-cleanup'
import { runTrackCleanupForFlight } from './run-track-cleanup'
import { deriveFlownRouteJson } from './route-simplify'

// A touchdown only counts as a *new* one after this many consecutive airborne samples
// since the last one — at the 1 Hz telemetry rate every SimConnect period request uses
// (SimConnectService), a handful of seconds genuinely airborne rules out a rollout bounce
// (gear compression briefly reporting on-ground->off->on again) without missing a real
// short circuit hop (flightdeck-backend's docs/plans/multiple-landings.md).
const MIN_AIRBORNE_SAMPLES_FOR_NEW_TOUCHDOWN = 3
// How far from the touchdown position to look for the airport it happened at
// (nearestAirport, airport-search.ts) before falling back to the flight's filed arrival —
// generous enough to cover a long runway's far end or a touchdown just short of the
// threshold, tight enough not to pick up a different nearby field.
const LANDING_ICAO_SEARCH_RADIUS_NM = 5

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
  private fuelOutFinalized = false
  // Landing capture (flightdeck-backend's docs/plans/multiple-landings.md) — keyed off the
  // raw telemetry.onGround false->true edge directly, independent of the phase machine's
  // own descent -> landing transition, which has real holes for circuit flying (a tight
  // circuit that never holds level for ten seconds never reaches 'descent' at all).
  // landingSeq is 0 until the first touchdown, then increments per touchdown captured —
  // it, not a boolean, is what lets every touchdown get its own row instead of only the
  // first. wasOnGround starts undefined (no prior tick to compare against) so the very
  // first tick of a flight already on the ground can never itself read as an edge.
  // airborneStreak counts consecutive airborne samples since the last ground contact —
  // gated against MIN_AIRBORNE_SAMPLES_FOR_NEW_TOUCHDOWN so a rollout bounce (gear
  // compression briefly reporting on-ground->off->on) doesn't count as landing #2.
  private landingSeq = 0
  private wasOnGround: boolean | undefined
  private airborneStreak = 0
  // True only for a flight started via startFree() — gates the arrival-resolution behaviour
  // below to free flights (free-flight-tracking.md's "Arrival is resolved, not filed") so a
  // normally dispatched flight keeps its filed arr_icao exactly as before, even on a real
  // diversion (a separate, already-known gap this doesn't touch).
  private isFreeFlight = false
  // Mirrors FlightRecorder's own `paused` flag — detectTouchdown needs the same guard the
  // phase machine applies internally, since it now runs independently of it.
  private paused = false
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
  // The raw tick immediately before the current one — every tick, not just persisted ones
  // (unlike lastPersistedPoint above, which skips whatever a phase's downsampling drops).
  // landing-capture.ts's buildLandingRecord needs this exact predecessor for a more honest
  // touchdown vertical speed than the touchdown tick's own value (flightdeck-backend's
  // docs/plans/flight-replay-harness.md, 2026-09-14 finding).
  private previousTelemetry: SimTelemetry | undefined

  constructor(
    private readonly db: WingLogDb,
    private readonly simConnectService: SimConnectSource,
    /** Asks the sim which airfield/runway a touchdown was on, for fields the vendored
     *  airport list doesn't know (landing-airfield-from-sim.md). Omitted in tests and in
     *  replay mode, where there's no live sim to ask. */
    private readonly resolveSimAirfield?: (lat: number, lon: number, headingTrueDeg: number) => Promise<SimAirfieldMatch | null>
  ) {
    super()
    this.simConnectService.on('telemetry', (telemetry) => {
      if (!this.recorder) return
      const previousTelemetry = this.previousTelemetry
      this.previousTelemetry = telemetry
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

      // Independent of the phase machine's own descent -> landing edge — keyed off the raw
      // telemetry directly so a circuit that never reaches 'descent' still gets its
      // touchdown captured (flightdeck-backend's docs/plans/multiple-landings.md). Guarded
      // the same way FlightRecorder.ingest guards phase advancement, since a slew teleport
      // or a paused sim can otherwise report a nonsensical onGround flip.
      if (!this.paused && !telemetry.slewActive) {
        this.detectTouchdown(telemetry, previousTelemetry)
      }

      if (result.point) {
        const saved = createTrackPoint(this.db, result.point)
        this.emit('point', saved)
        this.checkForLiveJump(saved)
      }

      if (result.phase === 'shutdown') {
        const flightId = this.recorder.getFlightId()
        this.resolveFreeFlightArrival(flightId, telemetry)
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
      this.paused = paused
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

  /**
   * Captures a touchdown on the raw telemetry.onGround false->true edge, independent of
   * the phase machine (flightdeck-backend's docs/plans/multiple-landings.md) — called for
   * every tick while a flight is tracked (guarded by the caller against pause/slew).
   * `wasOnGround`/`airborneStreak` are read before being updated for this tick, so the
   * hysteresis check sees how many consecutive airborne samples preceded *this* ground
   * contact, not this one itself.
   */
  private detectTouchdown(telemetry: SimTelemetry, previousTelemetry: SimTelemetry | undefined): void {
    if (!this.recorder) return
    const isTouchdown =
      this.wasOnGround === false &&
      telemetry.onGround &&
      this.airborneStreak >= MIN_AIRBORNE_SAMPLES_FOR_NEW_TOUCHDOWN
    this.wasOnGround = telemetry.onGround
    this.airborneStreak = telemetry.onGround ? 0 : this.airborneStreak + 1
    if (!isTouchdown) return

    const flightId = this.recorder.getFlightId()
    // Last-wins, not first: air_minutes should span first liftoff -> *final* touchdown,
    // not stop counting at the first one a circuit flies.
    recordOn(this.db, flightId)
    this.landingSeq += 1
    const flight = getFlight(this.db, flightId)
    if (!flight) return
    // This touchdown's own airport, not assumed to be the flight's filed arrival — a
    // circuit, a diversion, or a free flight can land somewhere else. Falls back to
    // arr_icao when nothing vendored is close enough to resolve.
    const resolvedIcao = nearestAirport(telemetry.latitude, telemetry.longitude, LANDING_ICAO_SEARCH_RADIUS_NM)
    const seq = this.landingSeq
    const touchdownTsUtc = new Date().toISOString()
    const record = buildLandingRecord(
      flightId,
      seq,
      resolvedIcao ?? flight.arrIcao,
      telemetry,
      touchdownTsUtc,
      undefined,
      previousTelemetry
    )
    createLanding(this.db, record)
    // No runway from the vendored data — a scenery add-on, a closed field, a strip missing
    // from OurAirports (the Kai Tak touch-and-go landed on a nearby heliport's code with no
    // runway). The sim knows those; ask it and upgrade the row once it answers.
    if (record.runwayIdent === null) {
      void this.upgradeLandingFromSim(flightId, seq, telemetry, touchdownTsUtc, previousTelemetry)
    }
    // A free flight's arr_icao is a placeholder ('ZZZZ' or an unconfirmed guess) until
    // something real is known — the touchdown position is that first real signal
    // (free-flight-tracking.md's "Arrival is resolved, not filed"). A dispatched flight's
    // filed arrival is left alone even when this resolves to somewhere else (a real
    // diversion), a separate, already-known gap this isn't scoped to fix.
    if (this.isFreeFlight && resolvedIcao) setArrIcao(this.db, flightId, resolvedIcao)
  }

  /** Replaces a landing's airfield/runway (and everything derived from the runway) with the
   *  sim's answer when it has one. The touchdown itself was already recorded from vendored
   *  data, so a missing, slow or failing sim just leaves that record as it was. */
  private async upgradeLandingFromSim(
    flightId: number,
    seq: number,
    telemetry: SimTelemetry,
    touchdownTsUtc: string,
    previousTelemetry: SimTelemetry | undefined
  ): Promise<void> {
    if (!this.resolveSimAirfield) return
    try {
      const match = await this.resolveSimAirfield(telemetry.latitude, telemetry.longitude, telemetry.headingTrueDeg)
      if (!match) return
      createLanding(
        this.db,
        buildLandingRecord(flightId, seq, match.icao, telemetry, touchdownTsUtc, () => match.runway, previousTelemetry)
      )
      // Free flight: the arrival was set from the (wrong) vendored guess — correct it, but
      // only while this is still the latest touchdown, so a late answer never overwrites a
      // later landing's arrival.
      if (this.isFreeFlight && this.recorder?.getFlightId() === flightId && this.landingSeq === seq) {
        setArrIcao(this.db, flightId, match.icao)
      }
    } catch {
      // Best effort only.
    }
  }

  /** Re-resolves a free flight's arrival at completion, in case of a taxi to a different
   *  field after the final touchdown already set one — must run before completeFlight,
   *  which copies arr_icao into aircraft.current_icao. A no-op for a dispatched flight or
   *  when there's no live telemetry to resolve from (finish() called with the sim
   *  disconnected). */
  private resolveFreeFlightArrival(flightId: number, telemetry: SimTelemetry | undefined): void {
    if (!this.isFreeFlight || !telemetry) return
    const icao = nearestAirport(telemetry.latitude, telemetry.longitude, LANDING_ICAO_SEARCH_RADIUS_NM)
    if (icao) setArrIcao(this.db, flightId, icao)
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
    if (this.recorder) {
      const stale = this.recorder.getFlightId()
      // A *different* flight is still 'active' in memory. If it's made zero real progress —
      // no track points recorded, never even got off the ground — it's almost certainly a
      // stale artifact (a dispatch attempt abandoned mid-setup, or auto-start firing for a
      // since-superseded plan) rather than something worth protecting, so retire it
      // automatically instead of blocking the flight actually being started now. Without
      // this, that stale flight was left stuck at status='active' forever — invisible for
      // the rest of the session, surfacing only as a confusing "resume?" prompt on the
      // *next* app restart (a real orphaned flight found 2026-09-14, flightdeck-backend's
      // docs/plans/flight-replay-harness.md). Same flightId, or any flight with real
      // progress, still throws — never silently restart a duplicate call or abandon actual
      // data.
      const staleFlight = getFlight(this.db, stale)
      const hasProgress = staleFlight?.actualOffUtc != null || listTrackPoints(this.db, stale).length > 0
      if (stale === flightId || hasProgress) throw new Error(`Already tracking flight ${stale}`)
      this.stop()
    }
    if (!getFlight(this.db, flightId)) throw new Error(`Flight ${flightId} not found`)

    const telemetry = this.simConnectService.getLastTelemetry()
    if (!telemetry) throw new Error('Not connected to the sim')

    startFlight(this.db, flightId, telemetry.fuelTotalKg)
    this.recorder = new FlightRecorder(flightId)
    this.offRecorded = false
    this.landingSeq = 0
    this.wasOnGround = undefined
    this.airborneStreak = 0
    this.fuelOutFinalized = false
    this.isFreeFlight = false
    // A stale selection from whatever flight was tracked previously must never leak onto
    // this one — start with nothing cached; createFlight's own saved-at-plan-time values
    // (if any) are untouched until/unless this flight's own selection gets pushed.
    this.currentSelection = undefined
    this.pausedIntervals = []
    this.openPauseStartIso = undefined
    this.lastPersistedPoint = undefined
    this.resumeWindowDeadlineMs = undefined
    this.previousTelemetry = undefined
  }

  /**
   * Starts tracking a flight with no SimBrief plan and no prior Dispatch "Fly" press —
   * free-flight-tracking.md. The confirmed dialog fields have already resolved which fleet
   * aircraft this is (or created a new one) by the time this is called; this method's own
   * job is creating the flight row directly at 'active' and seeding phase detection from
   * whatever the aircraft is already doing (mid-air included), rather than the normal
   * planned -> active transition start() drives.
   *
   * Returns the new flight's id so the caller (the IPC handler) can hand it back to the
   * renderer, e.g. to switch Track's view onto it immediately.
   */
  startFree(input: {
    /** Null when the pilot chose not to add this aircraft to the fleet — simRegistration/
     *  simIcaoType are then required instead. */
    aircraftId: number | null
    simRegistration?: string | null
    simIcaoType?: string | null
    depIcao: string
    arrIcao: string
    flightNumber: string | null
  }): number {
    if (this.recorder) {
      // Same stale-flight tolerance as start() above — a free flight is just as likely to
      // be started right after an abandoned dispatch attempt as a normal one is.
      const stale = this.recorder.getFlightId()
      const staleFlight = getFlight(this.db, stale)
      const hasProgress = staleFlight?.actualOffUtc != null || listTrackPoints(this.db, stale).length > 0
      if (hasProgress) throw new Error(`Already tracking flight ${stale}`)
      this.stop()
    }

    const telemetry = this.simConnectService.getLastTelemetry()
    if (!telemetry) throw new Error('Not connected to the sim')

    const flight = createFreeFlight(this.db, {
      aircraftId: input.aircraftId,
      simRegistration: input.simRegistration,
      simIcaoType: input.simIcaoType,
      // Only kept for a flight with no linked aircraft yet — same convention as
      // simRegistration/simIcaoType above. Lets a later Logbook "Add to fleet" remember this
      // add-on retroactively (linkAircraftToFlight); redundant when aircraftId is already set
      // here, since rememberAircraftForTitle below already runs immediately in that case.
      simTitle: input.aircraftId == null ? telemetry.title : null,
      depIcao: input.depIcao,
      arrIcao: input.arrIcao,
      flightNumber: input.flightNumber,
      fuelOutKg: telemetry.fuelTotalKg
      // simVersion: left unset, same as every other flight-creation path today — nothing
      // in the app currently populates it (a field with no wired-up source yet).
    })
    // Remembered regardless of how this flight's aircraft was resolved (an automatic
    // atcId fleet match, an existing title memory, or a brand-new fleet tail) — "whatever
    // the user confirms is what gets written," so the next flight in the same add-on
    // skips straight to the memory lookup (free-flight-tracking.md's aircraft-resolution
    // order). Skipped when the pilot chose not to add a fleet aircraft at all — there's
    // nothing to remember this title as next time.
    if (input.aircraftId != null) rememberAircraftForTitle(this.db, telemetry.title, input.aircraftId)

    const seededPhase = seedPhaseFromTelemetry(telemetry)
    this.recorder = new FlightRecorder(flight.id, { phase: seededPhase, hasLanded: false, resumeSegment: 0 })
    // A flight seeded straight into an airborne phase has already lifted off before
    // tracking began — the telemetry handler's own recordOff only fires on the 'climb'
    // transition edge, which a flight seeded past 'climb' (cruise/descent) will never touch
    // again. "Now" is the best available approximation of the real liftoff time, the same
    // spirit as the rest of this plan's position-at-a-moment approximations.
    this.offRecorded = seededPhase !== 'preflight' && seededPhase !== 'taxi'
    if (this.offRecorded) recordOff(this.db, flight.id)
    this.landingSeq = 0
    this.wasOnGround = undefined
    this.airborneStreak = 0
    this.fuelOutFinalized = false
    this.isFreeFlight = true
    this.currentSelection = undefined
    this.pausedIntervals = []
    this.openPauseStartIso = undefined
    this.lastPersistedPoint = undefined
    this.resumeWindowDeadlineMs = undefined
    this.previousTelemetry = undefined
    return flight.id
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
    // Continues the same seq sequence rather than restarting it — a resume mid-circuit
    // must not overwrite landing #1 with what should be landing #2.
    this.landingSeq = listLandingsByFlight(this.db, flightId).length
    this.wasOnGround = undefined
    this.airborneStreak = 0
    this.fuelOutFinalized = this.offRecorded
    // No persisted "this was a free flight" flag exists on the row — inferred instead from
    // the one thing that's always true of a free flight and never true of a dispatched one
    // today: Dispatch's save action hard-requires an OFP (free-flight-tracking.md's own
    // "What's confirmed" #2), so a null ofpJson on an 'active' flight can only be a free
    // flight. Keeps arrival resolution working across an app restart mid-free-flight.
    this.isFreeFlight = flight.ofpJson == null
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
    this.previousTelemetry = undefined
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
    this.resolveFreeFlightArrival(flightId, telemetry)
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
