/**
 * The sim connection and tracking's start-up wiring, split out of index.ts: opening the sim (live or a
 * replayed capture), creating the tracking controller with its dev diagnostics, wiring its live
 * output, background sync and auto-start, and recording where each flight finished.
 *
 * Wiring only; the behaviour is in the services it connects. index.ts calls these in the order it always did.
 */
import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import type { WingLogDb } from './db/client'
import { dbFlightStore } from './db/flight-store'
import { getFlight, setParkedStand } from './db/flight-repo'
import { getTrackingSettings } from './db/settings-repo'
import { createDiag, openDiagLog } from './diagnostics/diag'
import { DevDiagnostics } from './diagnostics/dev-diagnostics'
import { FlightCapture } from './diagnostics/flight-capture'
import { registerDiagnosticsHandlers } from './ipc/sim-handlers'
import type { LiveHub } from './live/LiveHub'
import { logger } from './logging/logger'
import type { SimFacilitiesProvider } from './navdata/sim-facilities-provider'
import { SimAirfieldResolver } from './airports/sim-airfield'
import { ReplaySimConnectService, parseReplayGap, type ReplayMode } from './sim/ReplaySimConnectService'
import { replayCapture, type ReplayedCapture } from './sim/replay-capture'
import { SimConnectService } from './sim/SimConnectService'
import { AutoStartDetector } from './tracking/AutoStartDetector'
import { recordParkedStand } from './tracking/parked-stand'
import { TrackingController } from './tracking/TrackingController'

/**
 * The sim connection: live, or a captured flight replayed for e2e.
 *
 * Phase 3's injection seam (winglog-backend's docs/plans/flight-replay-harness.md, closing
 * test-coverage.md Phase 4's open question): WINGLOG_E2E_FIXTURE, when set, swaps in a
 * ReplaySimConnectService driven by a captured NDJSON fixture instead of a live sim connection
 * — for an e2e/Playwright context that wants Track to actually receive telemetry without a
 * running MSFS. Unset (every normal launch) behaves exactly as before. Both classes satisfy
 * SimConnectSource, the interface TrackingController actually depends on, so no cast is needed
 * either way.
 *
 * @returns The connection (not started), and the replayed capture's BeyondATC and GSX streams
 *   when WINGLOG_E2E_REPLAY_STREAMS=1 asks for them (scenario-testing.md Part 1). `beyondatc` replays only BeyondATC's, leaving GSX to a
 *   real socket (a test's fake GSX server, whose service list the capture lacks).
 */
export function connectSim(): {
  sim: SimConnectService | ReplaySimConnectService
  replayStreams?: ReplayedCapture
} {
  const replayFixture = process.env.WINGLOG_E2E_FIXTURE
  const replay = replayFixture
    ? replayCapture(replayFixture, {
        mode: (process.env.WINGLOG_E2E_REPLAY_MODE as ReplayMode | undefined) ?? 'paced',
        speedMultiplier: process.env.WINGLOG_E2E_REPLAY_SPEED
          ? Number(process.env.WINGLOG_E2E_REPLAY_SPEED)
          : undefined,
        holdUntilReleased: process.env.WINGLOG_E2E_REPLAY_HOLD === '1',
        gap: parseReplayGap(process.env.WINGLOG_E2E_REPLAY_GAP_S)
      })
    : undefined
  return {
    sim: replay?.sim ?? new SimConnectService(),
    replayStreams:
      replay && ['1', 'beyondatc'].includes(process.env.WINGLOG_E2E_REPLAY_STREAMS ?? '') ? replay : undefined
  }
}

/**
 * The tracking controller, recording through the database.
 *
 * @param db The database.
 * @param sim The sim connection.
 * @param scheduleBackgroundSync Run after each change tracking makes to a flight or a landing.
 * @returns The controller, before anything listens to it.
 */
function createTracking(
  db: WingLogDb,
  sim: SimConnectService | ReplaySimConnectService,
  scheduleBackgroundSync: () => void
): TrackingController {
  // Replay mode has no live sim to ask for a touchdown's airfield.
  const simAirfieldResolver = sim instanceof ReplaySimConnectService ? undefined : new SimAirfieldResolver()
  return new TrackingController(
    dbFlightStore(db, scheduleBackgroundSync),
    sim,
    simAirfieldResolver && ((lat, lon, heading) => simAirfieldResolver.resolve(lat, lon, heading))
  )
}

/**
 * Tracking's live output and background sync, and auto-start.
 *
 * @param db The database.
 * @param sim The sim connection.
 * @param trackingController The tracking controller.
 * @param liveHub Where points go live.
 * @param scheduleBackgroundSync Run when a flight completes, after the dev diagnostics have closed its capture.
 * @returns The auto-start detector.
 */
function wireTracking(
  db: WingLogDb,
  sim: SimConnectService | ReplaySimConnectService,
  trackingController: TrackingController,
  liveHub: LiveHub,
  scheduleBackgroundSync: () => void
): AutoStartDetector {
  trackingController.on('point', (point) => liveHub.publish('trackingPoint', point))
  trackingController.on('pointsUpdated', (points) => liveHub.publish('trackingPointsUpdated', points))
  // Each write tracking makes to the logbook already schedules a sync (createTracking), completing the flight included. This one is the
  // last for the flight: it follows the dev diagnostics closing the capture, which listen first.
  trackingController.on('completed', () => scheduleBackgroundSync())

  // Auto-starts tracking once the sim has genuinely settled into a freshly-planned flight
  // (docs/decisions.md, scripts/spike-flight-reload.ts) — "Start tracking" stays as the
  // manual fallback for whenever this doesn't fire (e.g. the pilot doesn't reload MSFS).
  const autoStartDetector = new AutoStartDetector(sim)
  autoStartDetector.on('ready', (flightId) => {
    // Settings → Tracking → "Start tracking automatically" off: the pilot starts it.
    if (!getTrackingSettings(db).autoStart) return
    try {
      trackingController.start(flightId)
    } catch {
      // The flight may have been cancelled, or already started via the manual button,
      // between arming and this firing — safe to ignore either way.
    }
  })
  return autoStartDetector
}

/**
 * Creates tracking and its dev diagnostics, registers the diagnostics IPC, and wires tracking's live output, sync and auto-start.
 * Dev build only: diag.log and the full flight capture (src/main/diagnostics/).
 *
 * @param db The database.
 * @param sim The sim connection.
 * @param liveHub Where points go live.
 * @param scheduleBackgroundSync Run after each change tracking makes to a flight or a landing, so a twin and the cloud hear of it.
 * @returns The tracking controller, the dev diagnostics (dev builds only), and the auto-start detector.
 */
export function startTracking(
  db: WingLogDb,
  sim: SimConnectService | ReplaySimConnectService,
  liveHub: LiveHub,
  scheduleBackgroundSync: () => void
): {
  trackingController: TrackingController
  devDiagnostics?: DevDiagnostics
  autoStartDetector: AutoStartDetector
} {
  const trackingController = createTracking(db, sim, scheduleBackgroundSync)
  const diag = createDiag(__WINGLOG_DEV_BUILD__ ? openDiagLog() : null)
  const flightCapture = __WINGLOG_DEV_BUILD__
    ? new FlightCapture(join(app.getPath('userData'), 'captures'))
    : undefined
  const devDiagnostics = flightCapture ? new DevDiagnostics(diag, flightCapture) : undefined
  devDiagnostics?.attachTracking(trackingController, sim)
  registerDiagnosticsHandlers(ipcMain, { diag, flightCapture })
  const autoStartDetector = wireTracking(db, sim, trackingController, liveHub, scheduleBackgroundSync)
  return { trackingController, devDiagnostics, autoStartDetector }
}

/**
 * Records where each flight finished (stand-positions.md), after it completes, best effort.
 *
 * @param db The database.
 * @param sim The sim connection, for where the aircraft is.
 * @param trackingController Tracking, which says when a flight completes.
 * @param navdataProvider The stands of the airport.
 * @param scheduleBackgroundSync Run after the stand is written to the flight, so a twin hears of it.
 */
export function recordParkedStandOnCompletion(
  db: WingLogDb,
  sim: SimConnectService | ReplaySimConnectService,
  trackingController: TrackingController,
  navdataProvider: SimFacilitiesProvider,
  scheduleBackgroundSync: () => void
): void {
  trackingController.on('completed', (flightId: number) => {
    const telemetry = sim.getLastTelemetry()
    void recordParkedStand(
      {
        getArrivalIcao: (id) => getFlight(db, id)?.arrIcao ?? null,
        getStands: (icao) => navdataProvider.getStands(icao),
        // Written after the completion was synced, when the stand lookup was slow: a twin is told again.
        setParkedStand: (id, icao, stand) => {
          setParkedStand(db, id, icao, stand)
          scheduleBackgroundSync()
        }
      },
      flightId,
      telemetry ? { lat: telemetry.latitude, lon: telemetry.longitude } : null
    ).catch((err: unknown) => logger.warn('parked stand not recorded:', err))
  })
}
