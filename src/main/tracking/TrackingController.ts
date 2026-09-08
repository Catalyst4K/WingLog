import { EventEmitter } from 'node:events'
import type { ActiveTracking, ProcedureSelection, TrackPoint } from '@shared/ipc'
import type { WingLogDb } from '../db/client'
import { addInvoicesForFlight } from '../db/flight-invoice-repo'
import {
  abandonFlight,
  completeFlight,
  finalizeFuelOut,
  getFlight,
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
import type { SimConnectService } from '../sim/SimConnectService'
import { FlightRecorder } from './FlightRecorder'
import { buildLandingRecord } from './landing-capture'
import { deriveFlownRouteJson } from './route-simplify'

interface TrackingControllerEvents {
  point: [TrackPoint]
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

  constructor(
    private readonly db: WingLogDb,
    private readonly simConnectService: SimConnectService
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
      }

      if (result.phase === 'shutdown') {
        const flightId = this.recorder.getFlightId()
        completeFlight(this.db, flightId, telemetry.fuelTotalKg)
        this.snapshotGsxInvoices(flightId)
        this.deriveFlownRoute(flightId)
        this.persistSelection(flightId)
        this.recorder = undefined
        this.emit('completed', flightId)
      }
    })
    this.simConnectService.on('paused', (paused) => this.recorder?.setPaused(paused))
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
    completeFlight(this.db, flightId, telemetry?.fuelTotalKg ?? 0)
    this.snapshotGsxInvoices(flightId)
    this.deriveFlownRoute(flightId)
    this.persistSelection(flightId)
    this.recorder = undefined
    this.emit('completed', flightId)
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
    const points = listTrackPoints(this.db, flightId)
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
