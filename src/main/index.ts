/**
 * WingLog's main process: the composition root (coding-standards.md §5). It opens the database,
 * creates the window, LiveHub, the sim connection and the long-lived services, and hands each
 * area's IPC to its `register<Area>Handlers` module in src/main/ipc/. Behaviour lives in those
 * modules and the services, not here.
 */
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron'
import { IpcChannels } from '@shared/ipc'
import { initLogger, logger } from './logging/logger'
import { setMainLanguage, t } from './i18n'
import { backupDatabaseOnLaunch } from './db/backup'
import { createDb, type WingLogDb } from './db/client'
import { migrateDb } from './db/migrate'
import { migrateLegacyUserData } from './db/legacy-userdata'
import { getFlight, setParkedStand } from './db/flight-repo'
import {
  getAppLanguage,
  getSkippedUpdateVersion,
  getTrackingSettings,
  getUpdateSettings,
  setSkippedUpdateVersion
} from './db/settings-repo'
import { dbFlightStore } from './db/flight-store'
import { SimConnectService } from './sim/SimConnectService'
import { ReplaySimConnectService, type ReplayMode } from './sim/ReplaySimConnectService'
import { replayCapture, type ReplayedCapture } from './sim/replay-capture'
import { pointRegeditAtUnpackedScripts } from './sim/regedit-scripts'
import { registerFleetHandlers } from './ipc/fleet-handlers'
import { registerLogbookHandlers } from './ipc/logbook-handlers'
import { registerLookupHandlers } from './ipc/lookup-handlers'
import { registerAppHandlers } from './ipc/app-handlers'
import { registerSettingsHandlers } from './ipc/settings-handlers'
import { registerDispatchHandlers } from './ipc/dispatch-handlers'
import { registerNavdataHandlers } from './ipc/navdata-handlers'
import { registerFlightHandlers, registerTrackingHandlers } from './ipc/tracking-handlers'
import { registerGsxHandlers } from './ipc/gsx-handlers'
import { registerGsxRemoteHandlers } from './ipc/gsx-remote-handlers'
import { registerBeyondAtcHandlers } from './ipc/beyondatc-handlers'
import { registerDiagnosticsHandlers, registerSimHandlers } from './ipc/sim-handlers'
import { createBackgroundSync, registerSyncHandlers } from './ipc/sync-handlers'
import { e2eBeyondAtcPort } from './beyondatc/BeyondAtcService'
import { UpdateService } from './updates/update-check'
import { LiveHub } from './live/LiveHub'
import { SimFacilitiesProvider } from './navdata/sim-facilities-provider'
import { SimAirfieldResolver } from './airports/sim-airfield'
import { TrackingController } from './tracking/TrackingController'
import { AutoStartDetector } from './tracking/AutoStartDetector'
import { recordParkedStand } from './tracking/parked-stand'
import { createDiag, openDiagLog } from './diagnostics/diag'
import { DevDiagnostics } from './diagnostics/dev-diagnostics'
import { FlightCapture } from './diagnostics/flight-capture'
import { CloudSyncController } from './sync/cloud-sync-controller'

/**
 * Opens the database, first carrying a pre-rename install's data across, backing up what's
 * there, and migrating it to this version's schema.
 *
 * @param userDataPath Electron's userData directory.
 * @returns The database, and its file's path.
 */
function openDatabase(userDataPath: string): { db: WingLogDb; dbPath: string } {
  const dbPath = join(userDataPath, 'winglog.db')

  // Before anything opens the database: the Flightdeck -> WingLog rename moved userData,
  // so an existing install's logbook is sitting in the old directory. Runs before
  // migrateDb so the copied database then gets brought up to the current schema.
  const legacy = migrateLegacyUserData(userDataPath, dbPath)
  if (legacy.migrated) {
    logger.log(
      `Carried pre-rename data across from ${legacy.from}` +
        (legacy.sidecars.length > 0 ? ` (plus ${legacy.sidecars.join(', ')})` : '')
    )
  }

  // Safety net against a bad migration or a corrupted database (PLAN.md §M7) — snapshot
  // whatever's there now, before migrateDb below applies this version's migrations to it.
  // A no-op on a fresh install (backupDatabaseOnLaunch checks dbPath exists first).
  try {
    backupDatabaseOnLaunch(dbPath, join(userDataPath, 'backups'))
  } catch (error) {
    // Never block startup over a failed backup — logged for visibility, not fatal.
    logger.error('DB backup-on-launch failed:', error)
  }

  // app.getAppPath() is the project root in dev and the asar root when packaged — both
  // have drizzle/ as a direct sibling of package.json, unlike a cwd-relative path, which
  // isn't reliable once the app is launched from a shortcut rather than a terminal.
  migrateDb(dbPath, join(app.getAppPath(), 'drizzle'))
  return { db: createDb(dbPath).db, dbPath }
}

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
 *   when WINGLOG_E2E_REPLAY_STREAMS=1 asks for them (scenario-testing.md Part 1).
 */
function connectSim(): { sim: SimConnectService | ReplaySimConnectService; replayStreams?: ReplayedCapture } {
  const replayFixture = process.env.WINGLOG_E2E_FIXTURE
  const replay = replayFixture
    ? replayCapture(replayFixture, {
        mode: (process.env.WINGLOG_E2E_REPLAY_MODE as ReplayMode | undefined) ?? 'paced',
        speedMultiplier: process.env.WINGLOG_E2E_REPLAY_SPEED
          ? Number(process.env.WINGLOG_E2E_REPLAY_SPEED)
          : undefined,
        holdUntilReleased: process.env.WINGLOG_E2E_REPLAY_HOLD === '1'
      })
    : undefined
  return {
    sim: replay?.sim ?? new SimConnectService(),
    replayStreams: replay && process.env.WINGLOG_E2E_REPLAY_STREAMS === '1' ? replay : undefined
  }
}

/**
 * The tracking controller, recording through the database.
 *
 * @param db The database.
 * @param sim The sim connection.
 * @returns The controller, before anything listens to it.
 */
function createTracking(db: WingLogDb, sim: SimConnectService | ReplaySimConnectService): TrackingController {
  // Replay mode has no live sim to ask for a touchdown's airfield.
  const simAirfieldResolver = sim instanceof ReplaySimConnectService ? undefined : new SimAirfieldResolver()
  return new TrackingController(
    dbFlightStore(db),
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
 * @param scheduleBackgroundSync Run when a flight completes.
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
  // Push-on-mutation's real-time case: a flight reaching 'completed' (auto shutdown
  // detection or a manual finish()) is the highest-value moment to sync promptly, whether
  // or not the user touches any other IPC channel afterward.
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
 * The update check (winglog-backend's docs/plans/update-check.md, Part A; agreed 2026-10-02):
 * asks GitHub for the latest published release, on by default, switchable off in Settings →
 * About. The endpoint can only be overridden in an unpackaged build, for the Playwright
 * acceptance test's fake release server.
 *
 * @param db The database, for the settings and the skipped version.
 * @param window The window its status goes to.
 * @returns The started service.
 */
function startUpdates(db: WingLogDb, window: BrowserWindow): UpdateService {
  const updateService = new UpdateService({
    currentVersion: app.getVersion(),
    isEnabled: () => getUpdateSettings(db).checkEnabled,
    getSkippedVersion: () => getSkippedUpdateVersion(db),
    setSkippedVersion: (version) => setSkippedUpdateVersion(db, version),
    url: !app.isPackaged && process.env.WINGLOG_UPDATE_URL ? process.env.WINGLOG_UPDATE_URL : undefined
  })
  updateService.on('status', (status) => {
    if (!window.isDestroyed()) window.webContents.send(IpcChannels.updatesStatus, status)
  })
  updateService.start()
  return updateService
}

/** Opens the database and the window, starts the services, and registers every IPC area. */
function startApp(): void {
  const { db, dbPath } = openDatabase(app.getPath('userData'))

  // Main-process strings (native dialog titles, thrown validation messages that reach
  // the renderer verbatim as a toast) follow the same persisted setting the renderer
  // does — no IPC round-trip needed, since main already owns this DB row directly
  // (settings-repo.ts's getAppLanguage) and app.getLocale() is a synchronous Electron
  // API. Re-called from the settingsSetAppLanguage handler on every change, so a
  // freshly thrown error picks up a new language with no restart needed.
  setMainLanguage(getAppLanguage(db), app.getLocale())

  // No native menu bar — in-app navigation (the top tab bar in App.tsx) is the only
  // way to move around; a bare File/Edit/Window bar above it was clutter, not useful.
  Menu.setApplicationMenu(null)
  const window = createWindow()
  // Live state (sim, tracking, GSX Remote, BeyondATC) goes through one hub, and the window
  // is its first subscriber (winglog-backend's docs/plans/live-data-seam.md, part A).
  const liveHub = new LiveHub()
  liveHub.subscribe((topic, payload) => {
    if (!window.isDestroyed()) window.webContents.send(IpcChannels[topic], payload)
  })

  // Cloud sync (winglog-backend/docs/plans/cloud-sync.md) — off by default, and the only
  // feature that talks to winglog-backend for anything beyond the stateless SimBrief signing
  // route. Constructed before any mutating handler, so each can trigger a background sync
  // after a successful write. Pull-on-launch: one sync at startup when a session already
  // exists, so this device picks up whatever changed elsewhere since it last opened.
  // Fire-and-forget: syncNow() catches its own errors into getStatus().lastError and never
  // throws, and this must never block the window opening (offline at launch is normal).
  const cloudSync = new CloudSyncController(db, dbPath, app.getPath('userData'))
  if (cloudSync.getStatus().loggedIn) void cloudSync.syncNow()
  const scheduleBackgroundSync = createBackgroundSync(cloudSync)

  registerFleetHandlers(ipcMain, { db, window, scheduleBackgroundSync })
  registerLogbookHandlers(ipcMain, { db, window, scheduleBackgroundSync })
  registerLookupHandlers(ipcMain)
  registerDispatchHandlers(ipcMain, { db })

  const { sim, replayStreams } = connectSim()
  registerSimHandlers(ipcMain, { sim, liveHub })
  sim.start()
  app.on('before-quit', () => sim.stop())

  const trackingController = createTracking(db, sim)
  // Dev build only: diag.log and the full flight capture (src/main/diagnostics/).
  const diag = createDiag(__WINGLOG_DEV_BUILD__ ? openDiagLog() : null)
  const flightCapture = __WINGLOG_DEV_BUILD__
    ? new FlightCapture(join(app.getPath('userData'), 'captures'))
    : undefined
  const devDiagnostics = flightCapture ? new DevDiagnostics(diag, flightCapture) : undefined
  devDiagnostics?.attachTracking(trackingController, sim)
  registerDiagnosticsHandlers(ipcMain, { diag, flightCapture })
  const autoStartDetector = wireTracking(db, sim, trackingController, liveHub, scheduleBackgroundSync)

  const trackingDeps = {
    db,
    trackingController,
    autoStartDetector,
    getLastTelemetry: () => sim.getLastTelemetry(),
    // An e2e replay held until tracking starts (WINGLOG_E2E_REPLAY_HOLD) plays from here.
    releaseReplay: () => {
      if (sim instanceof ReplaySimConnectService) sim.release()
    },
    scheduleBackgroundSync
  }
  registerTrackingHandlers(ipcMain, trackingDeps)
  registerFlightHandlers(ipcMain, trackingDeps)
  trackingController.setAutoFinish(getTrackingSettings(db).autoFinish)

  registerGsxHandlers(ipcMain, { db, window, scheduleBackgroundSync })
  const gsxRemote = registerGsxRemoteHandlers(ipcMain, {
    db,
    liveHub,
    devDiagnostics,
    socketCtor: replayStreams?.gsx.socketCtor
  })
  app.on('before-quit', () => gsxRemote.stop())

  // Navdata: its own short-lived SimConnect connection per refresh, deliberately separate
  // from the live tracking connection (docs/navdata-notes.md's isolation finding).
  const navdataProvider = new SimFacilitiesProvider(db)
  const beyondAtc = registerBeyondAtcHandlers(ipcMain, {
    db,
    liveHub,
    trackingController,
    sim,
    listApproaches: (icao) => navdataProvider.listApproaches(icao),
    devDiagnostics,
    socketCtor: replayStreams?.beyondAtc.socketCtor,
    port: e2eBeyondAtcPort(process.env.WINGLOG_E2E_BEYONDATC_PORT)
  })
  app.on('before-quit', () => beyondAtc.stop())

  registerSyncHandlers(ipcMain, { cloudSync, enabled: __WINGLOG_CLOUD_SYNC_ENABLED__ })

  const updateService = startUpdates(db, window)
  app.on('before-quit', () => updateService.stop())
  registerSettingsHandlers(ipcMain, { db, trackingController })
  registerAppHandlers(ipcMain, { updateService })

  registerNavdataHandlers(ipcMain, { navdataProvider })
  // Where each flight finished (stand-positions.md) — after completion, best effort.
  trackingController.on('completed', (flightId: number) => {
    const telemetry = sim.getLastTelemetry()
    void recordParkedStand(
      {
        getArrivalIcao: (id) => getFlight(db, id)?.arrIcao ?? null,
        getStands: (icao) => navdataProvider.getStands(icao),
        setParkedStand: (id, icao, stand) => setParkedStand(db, id, icao, stand)
      },
      flightId,
      telemetry ? { lat: telemetry.latitude, lon: telemetry.longitude } : null
    ).catch((err: unknown) => logger.warn('parked stand not recorded:', err))
  })

  // CI packaging check (see .github/workflows/package.yml): proves the built
  // binary launches, migrates the DB and renders a first frame, then exits
  // clean — without needing a person at the keyboard on every platform.
  if (process.env['WINGLOG_SMOKE_TEST']) {
    window.on('ready-to-show', () => setTimeout(() => app.exit(0), 1000))
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 720,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  window.on('ready-to-show', () => window.show())

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

// Before anything else can throw — a crash logged nowhere is a crash nobody can debug.
initLogger()

// Before SimConnect's first connection attempt — see regedit-scripts.ts. Never fatal: at worst
// the registry lookup keeps failing the way it always has, and node-simconnect falls back.
try {
  const result = pointRegeditAtUnpackedScripts(app.isPackaged, process.resourcesPath)
  if (result !== null) logger.info(`regedit scripts: ${result}`)
} catch (err) {
  logger.warn('regedit scripts not redirected:', err)
}

// e2e-only (e2e/launch-app.ts always sets this): headless Linux CI's xvfb display has no
// real GPU, and Electron's bundled Chromium doesn't reliably fall back to a working
// software WebGL2 context on its own there — confirmed live via winglog-backend's
// docs/plans/test-coverage.md Phase 4 (Logbook's e2e test), where FlightMap's maplibre-gl
// map failed GPUInitializationError and then crashed the renderer on unmount
// (`Cannot read properties of undefined (reading 'destroy')`) with no switch set. Real
// users never hit this: WingLog only ships for Windows, always with a real GPU, and this
// only takes effect at all when the env var is present, which nothing but the e2e harness
// ever sets.
if (process.env['WINGLOG_E2E_SOFTWARE_GL']) {
  app.commandLine.appendSwitch('use-gl', 'angle')
  app.commandLine.appendSwitch('use-angle', 'swiftshader')
  app.commandLine.appendSwitch('ignore-gpu-blocklist')
}

// Without this, launching the exe again while a previous instance is still alive (a real
// crash can leave the process hung rather than fully exiting, especially with native
// modules like better-sqlite3/SimConnect in play — the exact scenario the resume/discard
// prompt above exists for) spawns a second, fully independent process sharing the same
// SQLite file: two SimConnect connections, two TrackingControllers with unrelated
// in-memory state, and one process's writes (e.g. discarding an orphaned flight) invisible
// to the other, which just carries on tracking it regardless. `requestSingleInstanceLock`
// makes a second launch attempt hand off to the first instance and quit instead.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows()
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.focus()
  })

  app
    .whenReady()
    .then(() => startApp())
    .catch((error: unknown) => {
      // Without this, a startup failure (e.g. a missing/broken migration) leaves the process
      // running with no window and no visible error — indistinguishable from "still loading"
      // until someone goes looking for it. A native dialog is the one thing guaranteed to work
      // even if nothing else in the app initialized. console.error is routed to the log file by
      // initLogger() above, so this failure is captured for a bug report too, not just shown once.
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
      logger.error('WingLog failed to start:', message)
      dialog.showErrorBox(t('startupFailed'), message)
      app.exit(1)
    })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
