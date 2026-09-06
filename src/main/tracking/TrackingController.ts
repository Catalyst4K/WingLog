import { EventEmitter } from 'node:events'
import type { ActiveTracking, TrackPoint } from '@shared/ipc'
import type { FlightdeckDb } from '../db/client'
import { addInvoicesForFlight } from '../db/flight-invoice-repo'
import {
  abandonFlight,
  completeFlight,
  getFlight,
  recordOff,
  recordOn,
  setFlownRoute,
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

  constructor(
    private readonly db: FlightdeckDb,
    private readonly simConnectService: SimConnectService
  ) {
    super()
    this.simConnectService.on('telemetry', (telemetry) => {
      if (!this.recorder) return
      const result = this.recorder.ingest(telemetry, new Date())

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
        completeFlight(this.db, this.recorder.getFlightId(), telemetry.fuelTotalKg)
        this.snapshotGsxInvoices(this.recorder.getFlightId())
        this.deriveFlownRoute(this.recorder.getFlightId())
        this.recorder = undefined
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
    const telemetry = this.simConnectService.getLastTelemetry()
    completeFlight(this.db, this.recorder.getFlightId(), telemetry?.fuelTotalKg ?? 0)
    this.snapshotGsxInvoices(this.recorder.getFlightId())
    this.deriveFlownRoute(this.recorder.getFlightId())
    this.recorder = undefined
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
}
