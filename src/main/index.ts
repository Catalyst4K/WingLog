import { isRetired } from '@shared/aircraft'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { initLogger } from './logging/logger'
import { setMainLanguage, t } from './i18n'
import { backupDatabaseOnLaunch } from './db/backup'
import { IpcChannels, type DispatchOfp, type DispatchOpenSimBriefParams, type BeyondAtcSettings, type GsxRemoteSettings, type NavdataProcedureKind, type NewFlight, type ProcedureSelection, type StartFreeFlightInput } from '@shared/ipc'
import { createDb } from './db/client'
import { migrateDb } from './db/migrate'
import { migrateLegacyUserData } from './db/legacy-userdata'
import { getAircraftById, getAircraftByRegistration } from './db/aircraft-repo'
import { addInvoicesForFlight, listInvoicesForFlight } from './db/flight-invoice-repo'
import { abandonAllPlanned, abandonFlight, createFlight, deleteFlight, getFlight, setParkedStand, getInProgressFlight, linkAircraftToFlight } from './db/flight-repo'
import { getAircraftIdForTitle, getAppLanguage, getBeyondAtcSettings, getGsxRemoteSettings, getGsxSettings, getSimbriefUsername, getSkippedUpdateVersion, getTrackingSettings, getUpdateSettings, setBeyondAtcSettings, setGsxRemoteSettings, setSkippedUpdateVersion } from './db/settings-repo'
import { getFreeFlightPrefill } from './tracking/free-flight'
import { defaultGsxReceiptsPath } from './gsx/default-path'
import { buildFlightMatchWindow } from './db/gsx-flight-window'
import { readReceipt, receiptFileFromPath, scanGsxFolder } from './gsx/scan'
import { extractOfpPdfUrl } from './simbrief/ofp-pdf'
import { fetchLatestOfp, parseOfp, type SimBriefOfp } from './simbrief/simbrief-client'
import { fetchSimbriefUsername, generateOfp, isSimbriefLoggedIn, loginToSimbrief, logoutOfSimbrief } from './simbrief/simbrief-generate'
import { SimConnectService } from './sim/SimConnectService'
import { ReplaySimConnectService, type ReplayMode } from './sim/ReplaySimConnectService'
import { replayCapture } from './sim/replay-capture'
import { registerFleetHandlers } from './ipc/fleet-handlers'
import { registerLogbookHandlers } from './ipc/logbook-handlers'
import { registerLookupHandlers } from './ipc/lookup-handlers'
import { registerAppHandlers } from './ipc/app-handlers'
import { registerSettingsHandlers } from './ipc/settings-handlers'
import { EMPTY_COMMAND_BAR, EMPTY_MENU, GsxRemoteService } from './gsx-remote/GsxRemoteService'
import { BeyondAtcService, e2eBeyondAtcPort } from './beyondatc/BeyondAtcService'
import { EMPTY_BEYONDATC_STATE } from '@shared/beyondatc-state'
import { UpdateService } from './updates/update-check'
import { LiveHub } from './live/LiveHub'
import { StepClimbController } from './beyondatc/step-climb'
import { ArrivalClearanceTracker } from './beyondatc/arrival-clearance'
import type { NavdataProvider } from './navdata/navdata-provider'
import { SimFacilitiesProvider } from './navdata/sim-facilities-provider'
import { SimAirfieldResolver } from './airports/sim-airfield'
import { TrackingController } from './tracking/TrackingController'
import { createDiag, isDiagCategory, MAX_LINE_CHARS, openDiagLog } from './diagnostics/diag'
import { DevDiagnostics } from './diagnostics/dev-diagnostics'
import { FlightCapture, isFlightId } from './diagnostics/flight-capture'
import { AutoStartDetector } from './tracking/AutoStartDetector'
import { CloudSyncController } from './sync/cloud-sync-controller'
import { pointRegeditAtUnpackedScripts } from './sim/regedit-scripts'
import { recordParkedStand } from './tracking/parked-stand'
import { dbFlightStore } from './db/flight-store'

/**
 * A blank/unresolved depIcao or arrIcao from the free-flight dialog becomes 'ZZZZ' — ICAO's
 * own "no location indicator assigned" code, not an invented sentinel — rather than leaving
 * either NOT NULL column null (free-flight-tracking.md's "When there's genuinely no
 * airport"). Whatever is given is trimmed/uppercased the same way AirportSearch's own
 * choices already are.
 */
function normalizeFreeFlightIcao(icao: string | null): string {
  const trimmed = icao?.trim().toUpperCase()
  return trimmed || 'ZZZZ'
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
    window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

// Before anything else can throw — a crash logged nowhere is a crash nobody can debug.
initLogger()

// Before SimConnect's first connection attempt — see regedit-scripts.ts. Never fatal: at worst
// the registry lookup keeps failing the way it always has, and node-simconnect falls back.
try {
  const result = pointRegeditAtUnpackedScripts(app.isPackaged, process.resourcesPath)
  if (result !== null) console.info(`regedit scripts: ${result}`)
} catch (err) {
  console.warn('regedit scripts not redirected:', err)
}

// e2e-only (e2e/launch-app.ts always sets this): headless Linux CI's xvfb display has no
// real GPU, and Electron's bundled Chromium doesn't reliably fall back to a working
// software WebGL2 context on its own there — confirmed live via flightdeck-backend's
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
    .then(() => {
      const userDataPath = app.getPath('userData')
      const dbPath = join(userDataPath, 'winglog.db')

      // Before anything opens the database: the Flightdeck -> WingLog rename moved userData,
      // so an existing install's logbook is sitting in the old directory. Runs before
      // migrateDb so the copied database then gets brought up to the current schema.
      const legacy = migrateLegacyUserData(userDataPath, dbPath)
      if (legacy.migrated) {
        console.log(
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
        console.error('DB backup-on-launch failed:', error)
      }

      // app.getAppPath() is the project root in dev and the asar root when packaged — both
      // have drizzle/ as a direct sibling of package.json, unlike a cwd-relative path, which
      // isn't reliable once the app is launched from a shortcut rather than a terminal.
      migrateDb(dbPath, join(app.getAppPath(), 'drizzle'))
      const { db } = createDb(dbPath)

      // Main-process strings (native dialog titles, thrown validation messages that reach
      // the renderer verbatim as a toast) follow the same persisted setting the renderer
      // does — no IPC round-trip needed, since main already owns this DB row directly
      // (settings-repo.ts's getAppLanguage) and app.getLocale() is a synchronous Electron
      // API. Re-called from the settingsSetAppLanguage handler below on every change, so a
      // freshly thrown error picks up a new language with no restart needed.
      setMainLanguage(getAppLanguage(db), app.getLocale())

      // No native menu bar — in-app navigation (the top tab bar in App.tsx) is the only
      // way to move around; a bare File/Edit/Window bar above it was clutter, not useful.
      Menu.setApplicationMenu(null)
      const window = createWindow()
      // Live state (sim, tracking, GSX Remote, BeyondATC) goes through one hub, and the window
      // is its first subscriber (flightdeck-backend's docs/plans/live-data-seam.md, part A).
      const liveHub = new LiveHub()
      liveHub.subscribe((topic, payload) => {
        if (!window.isDestroyed()) window.webContents.send(IpcChannels[topic], payload)
      })

      // Cloud sync (flightdeck-backend/docs/plans/cloud-sync.md) — off by default; nothing
      // above this point depends on it, and it's the only feature in the app that talks to
      // flightdeck-backend for anything beyond the stateless SimBrief signing route.
      // Constructed here, before any mutating handler below, so each of those can trigger a
      // background sync after a successful write — event-driven push
      // (flightdeck-backend/docs/plans/cloud-sync-v2.md #3).
      const cloudSync = new CloudSyncController(db, dbPath, app.getPath('userData'))
      // Pull-on-launch half of the same item: one sync at startup when a session already
      // exists, so this device picks up whatever changed elsewhere since it last opened
      // rather than waiting for the first local edit or a manual "Sync now". Fire-and-forget:
      // syncNow() already catches its own errors into getStatus().lastError and never throws,
      // and this must never block the window opening (e.g. offline at launch, the normal case
      // for an app that runs alongside a flight sim for hours).
      if (cloudSync.getStatus().loggedIn) void cloudSync.syncNow()

      // Push-on-mutation half: debounced rather than one sync per write, so a burst (a fleet
      // import, a fast sequence of tracking writes) doesn't fire a sync per row — syncNow()
      // is already a full pull-then-push cycle across all four tables, reusing the same
      // cursor-based mechanism "Sync now" and pull-on-launch use rather than a bespoke
      // single-row push path, per CLAUDE.md's boring-implementation preference. Offline is the
      // normal case, not the exception: a failed attempt just leaves lastSyncedAt where it
      // was, so the very next successful sync (the next write, app relaunch, or manual "Sync
      // now") naturally re-covers whatever this one missed — no separate retry/outbox needed.
      let backgroundSyncTimer: NodeJS.Timeout | null = null
      function scheduleBackgroundSync(): void {
        if (!cloudSync.getStatus().loggedIn) return
        if (backgroundSyncTimer) clearTimeout(backgroundSyncTimer)
        backgroundSyncTimer = setTimeout(() => void cloudSync.syncNow(), 2000)
      }

      registerFleetHandlers(ipcMain, { db, window, scheduleBackgroundSync })
      registerLogbookHandlers(ipcMain, { db, window, scheduleBackgroundSync })
      registerLookupHandlers(ipcMain)

      function mapOfpForIpc(ofp: SimBriefOfp): DispatchOfp {
        const matched = getAircraftByRegistration(db, ofp.aircraftRegistration)
        const { rawJson, ...rest } = ofp
        return { ...rest, ofpJson: rawJson, matchedAircraftId: matched?.id ?? null }
      }

      ipcMain.handle(IpcChannels.dispatchFetchOfp, async (): Promise<DispatchOfp> => {
        const username = getSimbriefUsername(db)
        if (!username) throw new Error(t('errors.setSimbriefUsernameFirst'))
        return mapOfpForIpc(await fetchLatestOfp(username))
      })

      ipcMain.handle(IpcChannels.dispatchGetInProgressFlight, () => {
        const inProgress = getInProgressFlight(db)
        if (!inProgress?.ofpJson) return null
        try {
          return { flight: inProgress, ofp: mapOfpForIpc(parseOfp(JSON.parse(inProgress.ofpJson))) }
        } catch {
          // A malformed/unexpected stored ofpJson must degrade to "nothing to restore",
          // not break Dispatch on every future launch — external data, parsed defensively.
          return null
        }
      })

      ipcMain.handle(
        IpcChannels.dispatchGenerateOfp,
        async (_event, params: DispatchOpenSimBriefParams): Promise<DispatchOfp> => {
          const username = getSimbriefUsername(db)
          if (!username) throw new Error(t('errors.setSimbriefUsernameFirst'))

          // Baseline for the "did a new plan actually appear" check below — best-effort, a
          // pilot with no prior OFP at all is a valid starting state, not an error.
          const baselineOfpId = await fetchLatestOfp(username)
            .then((ofp) => ofp.ofpId)
            .catch(() => null)

          await generateOfp(params)

          const ofp = await fetchLatestOfp(username)
          if (ofp.ofpId === baselineOfpId) {
            throw new Error(t('errors.noNewPlanGenerated'))
          }
          return mapOfpForIpc(ofp)
        }
      )

      ipcMain.handle(IpcChannels.dispatchLoginSimbrief, () => loginToSimbrief())
      ipcMain.handle(IpcChannels.dispatchSimbriefLoginStatus, () => isSimbriefLoggedIn())
      ipcMain.handle(IpcChannels.dispatchLogoutSimbrief, () => logoutOfSimbrief())
      ipcMain.handle(IpcChannels.dispatchFetchSimbriefUsername, () => fetchSimbriefUsername())

      ipcMain.handle(IpcChannels.dispatchOpenSimBrief, (_event, params: DispatchOpenSimBriefParams) => {
        const {
          origIcao,
          destIcao,
          icaoType,
          simbriefAirframeId,
          simbriefType,
          airlineIcao,
          flightNumber,
          departure,
          extra
        } = params
        if (!origIcao || !destIcao || (!icaoType && !simbriefAirframeId)) {
          return shell.openExternal('https://dispatch.simbrief.com/')
        }
        // `airframe=` takes priority when a saved SimBrief profile exists; otherwise `type=`
        // lets SimBrief fall back to its own default airframe for that type ICAO — SimBrief's
        // own behavior, nothing WingLog implements itself (docs/decisions.md). A chosen
        // simbriefType (a specific SimBrief default, e.g. "A20N" rather than the bare
        // icaoType "A320") takes priority over icaoType within that fallback.
        const airframeParam = simbriefAirframeId
          ? `airframe=${encodeURIComponent(simbriefAirframeId)}`
          : `type=${encodeURIComponent(simbriefType || icaoType)}`
        let url =
          `https://dispatch.simbrief.com/options/custom?orig=${encodeURIComponent(origIcao)}` +
          `&dest=${encodeURIComponent(destIcao)}&${airframeParam}`
        // Optional generation prefills (docs/decisions.md, SimBrief-generation entry) — each
        // only appended when present, so leaving them unset reproduces the URL above exactly.
        // Verified live 2026-09-02 (docs/simbrief-notes.md) that the keyless prefill form
        // honours all of these, including `date` taking epoch seconds rather than a date
        // string — `departure` arrives pre-converted from src/renderer/src/dispatch-time.ts,
        // never computed here from free text.
        if (airlineIcao) url += `&airline=${encodeURIComponent(airlineIcao)}`
        if (flightNumber) url += `&fltnum=${encodeURIComponent(flightNumber)}`
        if (departure) {
          url += `&date=${departure.dateEpochSeconds}&deph=${departure.hour}&depm=${departure.minute}`
        }
        // Advanced options (pax/fuel/cruise/route) from src/shared/dispatch-options.ts — already reduced
        // to only the fields the user actually set, so an untouched advanced dialog appends
        // nothing here (docs/decisions.md, dispatch-advanced-tab entry).
        for (const [key, value] of extra ?? []) {
          url += `&${encodeURIComponent(key)}=${encodeURIComponent(value)}`
        }
        return shell.openExternal(url)
      })

      ipcMain.handle(IpcChannels.dispatchOpenSimBriefAirframes, (_event, airframeId: string | null) => {
        // The internal ID is `<simbrief user id>_<airframe id>`, and the per-airframe editor
        // takes just the suffix (docs/simbrief-notes.md, "Saved airframes" — confirmed live
        // against a real airframe). Treated as an opaque string, never parsed as a date, even
        // though it happens to look like a millisecond epoch — an older ID format uses a
        // 10-digit seconds value instead, and the rule is "take the suffix verbatim" either
        // way. Falls back to the plain list page for a malformed/absent ID, or one from
        // before this format existed.
        const suffix = airframeId?.split('_')[1]
        const url = suffix
          ? `https://dispatch.simbrief.com/airframes/saved/${encodeURIComponent(suffix)}`
          : 'https://dispatch.simbrief.com/airframes'
        return shell.openExternal(url)
      })

      // Sibling of logbookOpenOfpPdf (docs/plans/dispatch-action-buttons.md) — a
      // fetched-but-not-yet-flown Dispatch plan has no flight row to look the OFP JSON up by
      // id, but the renderer already holds it (DispatchOfp.ofpJson), so it's passed straight
      // through instead. extractOfpPdfUrl already treats its input as untrusted third-party
      // JSON and validates the resulting URL (https: and www.simbrief.com only) before it ever
      // reaches shell.openExternal — unchanged, must stay that way.
      ipcMain.handle(IpcChannels.dispatchOpenOfpPdf, async (_event, ofpJson: string) => {
        const url = extractOfpPdfUrl(ofpJson)
        if (!url) return false
        await shell.openExternal(url)
        return true
      })
      // Always true now — generation goes through flightdeck-backend rather than a per-build
      // key, so there's no "build with no key baked in" case to fall back from anymore. Kept
      // as a channel (rather than removing it and the renderer's "Plan on SimBrief…" fallback
      // entirely) in case a future bring-your-own-key or backend-downtime path wants it back.
      ipcMain.handle(IpcChannels.dispatchGenerationAvailable, () => true)

      // Phase 3's injection seam (flightdeck-backend's docs/plans/flight-replay-harness.md,
      // closing test-coverage.md Phase 4's open question): WINGLOG_E2E_FIXTURE, when set,
      // swaps in a ReplaySimConnectService driven by a captured NDJSON fixture instead of a
      // live sim connection — for an e2e/Playwright context that wants Track to actually
      // receive telemetry without a running MSFS. Unset (every normal launch) behaves exactly
      // as before. Both classes satisfy SimConnectSource, the interface TrackingController
      // actually depends on, so no cast is needed either way.
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
      const simConnectService: SimConnectService | ReplaySimConnectService = replay?.sim ?? new SimConnectService()
      // WINGLOG_E2E_REPLAY_STREAMS=1: BeyondATC and GSX get the capture's own messages, on the
      // replay's clock, instead of connecting to a server (scenario-testing.md Part 1).
      const replayStreams = replay && process.env.WINGLOG_E2E_REPLAY_STREAMS === '1' ? replay : undefined
      ipcMain.handle(IpcChannels.simConnectionStatusGet, () => simConnectService.getStatus())
      simConnectService.on('telemetry', (telemetry) => {
        liveHub.publish('simTelemetry', telemetry)
      })
      simConnectService.on('status', (status) => {
        liveHub.publish('simConnectionStatus', status)
      })
      simConnectService.start()
      app.on('before-quit', () => simConnectService.stop())

      // Replay mode has no live sim to ask for a touchdown's airfield.
      const simAirfieldResolver = replayFixture ? undefined : new SimAirfieldResolver()
      const trackingController = new TrackingController(
        dbFlightStore(db),
        simConnectService,
        simAirfieldResolver && ((lat, lon, heading) => simAirfieldResolver.resolve(lat, lon, heading))
      )
      // Dev build only: diag.log and the full flight capture (src/main/diagnostics/).
      const diag = createDiag(__WINGLOG_DEV_BUILD__ ? openDiagLog() : null)
      const flightCapture = __WINGLOG_DEV_BUILD__ ? new FlightCapture(join(app.getPath('userData'), 'captures')) : undefined
      const devDiagnostics = flightCapture ? new DevDiagnostics(diag, flightCapture) : undefined
      devDiagnostics?.attachTracking(trackingController, simConnectService)
      ipcMain.handle(IpcChannels.diagLog, (_event, category: unknown, message: unknown) => {
        if (!isDiagCategory(category) || typeof message !== 'string') return
        diag(category, message.slice(0, MAX_LINE_CHARS))
      })
      ipcMain.handle(IpcChannels.captureKeepState, (_event, flightId: unknown) =>
        flightCapture && isFlightId(flightId) ? flightCapture.keepState(flightId) : 'none'
      )
      ipcMain.handle(IpcChannels.captureKeep, (_event, flightId: unknown) =>
        flightCapture && isFlightId(flightId) ? flightCapture.keep(flightId) : 'none'
      )
      // The one flight left "in progress" (planned or already active) when the previous
      // process quit or crashed — its DB row (OFP, route, everything Dispatch/Track need)
      // was never at risk, only TrackingController's in-memory phase-detection state, which
      // only exists at all once a flight reaches 'active'. Left as a choice for the user
      // (not auto-resumed/auto-continued) rather than assumed, since only the user can
      // judge whether it's still relevant — captured once here, at startup, and cleared the
      // moment the renderer answers the prompt this drives (trackingGetOrphanedFlight/
      // trackingResumeOrphaned/trackingDiscardOrphaned below). trackingController.resume()
      // itself already no-ops for a merely-'planned' flight (nothing was ever tracking it),
      // so "resume" is safe to call unconditionally regardless of which status this is.
      let orphanedFlight = getInProgressFlight(db)

      trackingController.on('point', (point) => {
        liveHub.publish('trackingPoint', point)
      })
      trackingController.on('pointsUpdated', (points) => {
        liveHub.publish('trackingPointsUpdated', points)
      })
      // Push-on-mutation's real-time case: a flight reaching 'completed' (auto shutdown
      // detection or a manual finish()) is the highest-value moment to sync promptly, whether
      // or not the user touches any other IPC channel afterward.
      trackingController.on('completed', () => scheduleBackgroundSync())

      // Auto-starts tracking once the sim has genuinely settled into a freshly-planned flight
      // (docs/decisions.md, scripts/spike-flight-reload.ts) — "Start tracking" stays as the
      // manual fallback for whenever this doesn't fire (e.g. the pilot doesn't reload MSFS).
      const autoStartDetector = new AutoStartDetector(simConnectService)
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

      // An e2e replay held until tracking starts (WINGLOG_E2E_REPLAY_HOLD) plays from here.
      const releaseReplay = (): void => {
        if (simConnectService instanceof ReplaySimConnectService) simConnectService.release()
      }
      ipcMain.handle(IpcChannels.trackingStart, (_event, flightId: number) => {
        autoStartDetector.disarm()
        trackingController.start(flightId)
        releaseReplay()
      })
      ipcMain.handle(IpcChannels.trackingStartFree, (_event, input: StartFreeFlightInput) => {
        let simRegistration: string | null = null
        let simIcaoType: string | null = null
        if (input.aircraftId != null) {
          const aircraft = getAircraftById(db, input.aircraftId)
          if (!aircraft || isRetired(aircraft)) {
            throw new Error(t('errors.aircraftNotFoundOrRetired', { id: input.aircraftId }))
          }
        } else {
          simRegistration = input.simRegistration?.trim() || ''
          simIcaoType = input.simIcaoType?.trim().toUpperCase() || ''
          if (!simRegistration || !simIcaoType) {
            throw new Error(t('errors.registrationAndTypeRequired'))
          }
        }
        autoStartDetector.disarm()
        const flightId = trackingController.startFree({
          aircraftId: input.aircraftId,
          simRegistration,
          simIcaoType,
          depIcao: normalizeFreeFlightIcao(input.depIcao),
          arrIcao: normalizeFreeFlightIcao(input.arrIcao),
          flightNumber: input.flightNumber?.trim() || null
        })
        releaseReplay()
        scheduleBackgroundSync()
        return flightId
      })
      ipcMain.handle(
        IpcChannels.trackingGetFreeFlightPrefill,
        (
          _event,
          input: { atcId: string; atcModel: string; title: string; latitude: number; longitude: number }
        ) => getFreeFlightPrefill((title) => getAircraftIdForTitle(db, title), input)
      )
      ipcMain.handle(IpcChannels.trackingStop, () => trackingController.stop())
      ipcMain.handle(IpcChannels.trackingFinish, () => trackingController.finish())
      ipcMain.handle(IpcChannels.trackingGetActive, () => trackingController.getActive() ?? null)
      ipcMain.handle(IpcChannels.trackingSetDestination, (_event, icao: unknown) => {
        if (icao !== null && typeof icao !== 'string') throw new Error(t('errors.invalidDestination'))
        trackingController.setDestination(icao)
      })
      ipcMain.handle(IpcChannels.trackingSetDeparture, (_event, icao: unknown) => {
        if (icao !== null && typeof icao !== 'string') throw new Error(t('errors.invalidDeparture'))
        trackingController.setDeparture(icao)
      })
      ipcMain.handle(IpcChannels.trackingSetProcedureSelection, (_event, selection: ProcedureSelection) =>
        trackingController.setProcedureSelection(selection)
      )
      ipcMain.handle(IpcChannels.trackingGetOrphanedFlight, () => orphanedFlight ?? null)
      ipcMain.handle(IpcChannels.trackingResumeOrphaned, (_event, flightId: number) => {
        if (orphanedFlight?.id !== flightId) return
        trackingController.resume(flightId)
        orphanedFlight = undefined
      })
      ipcMain.handle(IpcChannels.trackingDiscardOrphaned, (_event, flightId: number) => {
        if (orphanedFlight?.id !== flightId) return
        abandonFlight(db, flightId)
        orphanedFlight = undefined
        scheduleBackgroundSync()
      })

      // Only one flight is ever meant to be "in progress" (planned or active) at once —
      // pressing "Fly" on a new plan replaces whatever was already planned or being tracked,
      // rather than letting flights pile up alongside each other.
      ipcMain.handle(IpcChannels.flightCreate, (_event, input: NewFlight) => {
        trackingController.stop()
        abandonAllPlanned(db)
        const flight = createFlight(db, input)
        autoStartDetector.arm(flight.id, simConnectService.getLastTelemetry(), flight.depIcao)
        scheduleBackgroundSync()
        return flight
      })
      ipcMain.handle(IpcChannels.flightCancel, (_event, id: number) => {
        abandonFlight(db, id)
        autoStartDetector.disarm()
        scheduleBackgroundSync()
      })
      ipcMain.handle(IpcChannels.flightDelete, (_event, id: number) => {
        // Refuse to delete the flight currently being tracked out from under
        // TrackingController — stop() (same path flightCancel uses) first if it's the one.
        if (trackingController.getActive()?.flightId === id) trackingController.stop()
        deleteFlight(db, id)
        scheduleBackgroundSync()
      })
      ipcMain.handle(IpcChannels.flightLinkAircraft, (_event, flightId: number, aircraftId: number) => {
        const existingFlight = getFlight(db, flightId)
        if (!existingFlight) throw new Error(`Flight ${flightId} not found`)
        if (existingFlight.aircraftId != null) {
          throw new Error(t('errors.flightAlreadyHasLinkedAircraft', { flightId }))
        }
        const aircraftRow = getAircraftById(db, aircraftId)
        if (!aircraftRow || isRetired(aircraftRow)) {
          throw new Error(t('errors.aircraftNotFoundOrRetired', { id: aircraftId }))
        }
        const updated = linkAircraftToFlight(db, flightId, aircraftId)
        scheduleBackgroundSync()
        return updated
      })

      // GSX ground-service invoices (docs/decisions.md, gsx-invoices entry) — opt-in, off by
      // default, and a no-op everywhere below when disabled or unconfigured. Windows-only in
      // practice (GSX itself is Windows-only), but nothing here assumes that beyond
      // defaultGsxReceiptsPath returning null elsewhere.
      trackingController.setAutoFinish(getTrackingSettings(db).autoFinish)

      ipcMain.handle(IpcChannels.gsxBrowseFolder, async () => {
        const { canceled, filePaths } = await dialog.showOpenDialog(window, {
          title: t('dialogs.gsxReceiptsFolder'),
          defaultPath: defaultGsxReceiptsPath() ?? undefined,
          properties: ['openDirectory']
        })
        return canceled || filePaths.length === 0 ? null : filePaths[0]
      })

      ipcMain.handle(IpcChannels.gsxRescanFlight, async (_event, flightId: number) => {
        const settings = getGsxSettings(db)
        if (!settings.enabled || !settings.folderPath)
          return { invoices: listInvoicesForFlight(db, flightId), notailCandidates: [] }
        const matchWindow = buildFlightMatchWindow(db, flightId)
        if (!matchWindow) return { invoices: listInvoicesForFlight(db, flightId), notailCandidates: [] }

        const result = await scanGsxFolder(settings.folderPath, matchWindow)
        const invoices = addInvoicesForFlight(db, flightId, result.matched)
        if (result.matched.length > 0) scheduleBackgroundSync()
        return {
          invoices,
          notailCandidates: result.notailCandidates.map((f) => ({
            serviceGroup: f.serviceGroup,
            jsonPath: f.jsonPath,
            issuedUtc: f.parsed.timestampUtc,
            icao: f.parsed.icao
          }))
        }
      })

      ipcMain.handle(
        IpcChannels.gsxAttachNotailReceipt,
        async (_event, flightId: number, jsonPath: string) => {
          const file = receiptFileFromPath(jsonPath)
          if (!file) return listInvoicesForFlight(db, flightId)
          const invoice = await readReceipt(file)
          if (!invoice) return listInvoicesForFlight(db, flightId)
          const invoices = addInvoicesForFlight(db, flightId, [invoice])
          scheduleBackgroundSync()
          return invoices
        }
      )

      ipcMain.handle(IpcChannels.gsxOpenReceipt, (_event, sourceHtmlPath: string) =>
        shell.openPath(sourceHtmlPath)
      )

      // GSX Remote Control (flightdeck-backend's docs/plans/gsx-remote-control.md; live
      // protocol confirmed docs/gsx-notes.md, 2026-09-21) — unrelated to the file-based GSX
      // invoices above. Native reimplementation (docs/decisions.md, 2026-09-21 Option C):
      // GsxRemoteService owns the WebSocket, renderer only ever gets typed IPC. Off by
      // default; opt-in per user-entered host/port, same reasoning as GSX invoices' folder
      // path — GSX's Remote Client port is genuinely user-configurable, never assumed.
      let gsxRemoteService: GsxRemoteService | undefined
      const startGsxRemoteIfConfigured = (): void => {
        gsxRemoteService?.stop()
        gsxRemoteService = undefined
        const settings = getGsxRemoteSettings(db)
        if (!settings.enabled || !settings.port) return
        gsxRemoteService = new GsxRemoteService(settings.host, settings.port, replayStreams?.gsx.socketCtor)
        devDiagnostics?.attachGsx(gsxRemoteService)
        gsxRemoteService.on('status', (status) => {
          liveHub.publish('gsxRemoteStatus', status)
        })
        gsxRemoteService.on('services', (services) => {
          liveHub.publish('gsxRemoteServices', services)
        })
        gsxRemoteService.on('gate', (gate) => {
          liveHub.publish('gsxRemoteGate', gate)
        })
        gsxRemoteService.on('menu', (menu) => {
          liveHub.publish('gsxRemoteMenu', menu)
        })
        gsxRemoteService.on('prompt', (prompt) => {
          liveHub.publish('gsxRemotePrompt', prompt)
        })
        gsxRemoteService.on('commandBar', (commandBar) => {
          liveHub.publish('gsxRemoteCommandBar', commandBar)
        })
        gsxRemoteService.start()
      }
      startGsxRemoteIfConfigured()
      app.on('before-quit', () => gsxRemoteService?.stop())

      ipcMain.handle(IpcChannels.settingsGetGsxRemote, () => getGsxRemoteSettings(db))
      ipcMain.handle(IpcChannels.settingsSetGsxRemote, (_event, settings: GsxRemoteSettings) => {
        setGsxRemoteSettings(db, settings)
        startGsxRemoteIfConfigured()
      })
      ipcMain.handle(IpcChannels.gsxRemoteGetStatus, () => gsxRemoteService?.getStatus() ?? { state: 'disconnected', lastError: null })
      ipcMain.handle(IpcChannels.gsxRemoteGetServices, () => gsxRemoteService?.getServices() ?? [])
      ipcMain.handle(IpcChannels.gsxRemoteGetGateInfo, () => gsxRemoteService?.getGateInfo() ?? null)
      ipcMain.handle(IpcChannels.gsxRemoteGetMenu, () => gsxRemoteService?.getMenu() ?? EMPTY_MENU)
      ipcMain.handle(IpcChannels.gsxRemoteGetPrompt, () => gsxRemoteService?.getPrompt() ?? null)
      ipcMain.handle(IpcChannels.gsxRemoteGetCommandBar, () => gsxRemoteService?.getCommandBar() ?? EMPTY_COMMAND_BAR)
      ipcMain.handle(IpcChannels.gsxRemotePickMenu, (_event, index: unknown) => gsxRemoteService?.pickMenu(index))
      ipcMain.handle(IpcChannels.gsxRemoteSearch, (_event, text: unknown) => gsxRemoteService?.search(text))
      ipcMain.handle(IpcChannels.gsxRemoteToggleMenu, () => gsxRemoteService?.toggleMenu())
      ipcMain.handle(IpcChannels.gsxRemoteSubmitPrompt, (_event, gen: unknown, text: unknown) =>
        gsxRemoteService?.submitPrompt(gen, text)
      )
      ipcMain.handle(IpcChannels.gsxRemoteCancelPrompt, (_event, gen: unknown) => gsxRemoteService?.cancelPrompt(gen))
      ipcMain.handle(IpcChannels.gsxRemoteRunCommand, (_event, id: unknown) => gsxRemoteService?.runCommand(id))

      // BeyondATC integration (flightdeck-backend's docs/plans/beyondatc-integration.md;
      // live protocol confirmed docs/beyondatc-notes.md, 2026-09-25). Off by default,
      // opt-in per user-entered host — unlike GSX Remote, the port is fixed
      // (BeyondAtcService's own BEYONDATC_PORT), so there's no port to validate here.
      let beyondAtcService: BeyondAtcService | undefined
      // ATC's arrival clearance for the BeyondATC tab's info card, until touchdown.
      const arrivalClearance = new ArrivalClearanceTracker({
        getArrivalIcao: () => {
          const active = trackingController.getActive()
          return (active && getFlight(db, active.flightId)?.arrIcao) || beyondAtcService?.getState().progress?.to || null
        },
        listApproaches: (icao) => navdataProvider.listApproaches(icao)
      })
      arrivalClearance.on('clearance', (clearance) => {
        liveHub.publish('beyondAtcArrival', clearance)
      })
      trackingController.on('point', (point) => arrivalClearance.onPhase(point.phase))
      ipcMain.handle(IpcChannels.beyondAtcGetArrival, () => arrivalClearance.getClearance())
      const startBeyondAtcIfConfigured = (): void => {
        beyondAtcService?.stop()
        beyondAtcService = undefined
        const settings = getBeyondAtcSettings(db)
        if (!settings.enabled) return
        beyondAtcService = new BeyondAtcService(
          settings.host,
          e2eBeyondAtcPort(process.env.WINGLOG_E2E_BEYONDATC_PORT),
          replayStreams?.beyondAtc.socketCtor
        )
        devDiagnostics?.attachBeyondAtc(beyondAtcService)
        beyondAtcService.on('status', (status) => {
          liveHub.publish('beyondAtcStatus', status)
        })
        beyondAtcService.on('state', (state) => {
          liveHub.publish('beyondAtcState', state)
          arrivalClearance.onInfoBoxes(state.infoBoxes)
        })
        beyondAtcService.on('transcript', (transcript) => {
          liveHub.publish('beyondAtcTranscript', transcript)
        })
        beyondAtcService.start()
      }
      startBeyondAtcIfConfigured()
      app.on('before-quit', () => beyondAtcService?.stop())

      ipcMain.handle(IpcChannels.settingsGetBeyondAtc, () => getBeyondAtcSettings(db))
      ipcMain.handle(IpcChannels.settingsSetBeyondAtc, (_event, settings: BeyondAtcSettings) => {
        setBeyondAtcSettings(db, settings)
        startBeyondAtcIfConfigured()
      })
      ipcMain.handle(IpcChannels.beyondAtcGetStatus, () => beyondAtcService?.getStatus() ?? { state: 'disconnected', lastError: null })
      ipcMain.handle(IpcChannels.beyondAtcGetState, () => beyondAtcService?.getState() ?? EMPTY_BEYONDATC_STATE)
      ipcMain.handle(IpcChannels.beyondAtcGetTranscript, () => beyondAtcService?.getTranscript() ?? [])
      ipcMain.handle(IpcChannels.beyondAtcSetAction, (_event, label: unknown) => beyondAtcService?.setAction(label))
      ipcMain.handle(IpcChannels.beyondAtcSetFrequency, (_event, frequency: unknown) => beyondAtcService?.setFrequency(frequency))
      ipcMain.handle(IpcChannels.beyondAtcSetFrequencyCom2, (_event, frequency: unknown) =>
        beyondAtcService?.setFrequencyCom2(frequency)
      )
      ipcMain.handle(IpcChannels.beyondAtcSetAutoTune, (_event, value: unknown) => beyondAtcService?.setAutoTune(value))
      ipcMain.handle(IpcChannels.beyondAtcSetAutoRespond, (_event, value: unknown) => beyondAtcService?.setAutoRespond(value))

      // WingLog's own auto step climb (flightdeck-backend's docs/plans/beyondatc-auto-step-
      // climb.md) — asks BeyondATC for each new cruise level. Reads the current
      // beyondAtcService lazily, since settings changes replace it. Off every launch.
      const stepClimb = new StepClimbController({
        getSession: () => beyondAtcService,
        getActive: () => trackingController.getActive(),
        getOfpJson: (flightId) => getFlight(db, flightId)?.ofpJson ?? null
      })
      stepClimb.on('status', (status) => {
        liveHub.publish('beyondAtcStepClimb', status)
      })
      simConnectService.on('telemetry', (telemetry) => stepClimb.onTelemetry(telemetry))
      ipcMain.handle(IpcChannels.beyondAtcGetStepClimb, () => stepClimb.getStatus())
      ipcMain.handle(IpcChannels.beyondAtcSetStepClimb, (_event, enabled: unknown) => {
        if (typeof enabled === 'boolean') stepClimb.setEnabled(enabled)
      })

      // Cloud sync build-time flag (docs/plans/public-release-v1.md, Decision 1) — off in what
      // ships publicly. cloudSync itself is still constructed above regardless (its
      // pull-on-launch/background-sync scheduling stays harmless when logged out, which a
      // public build always is: there's no public signup route to have gotten an account
      // through in the first place), but these five channels — the only way to ever log in or
      // trigger a sync — simply don't exist when the flag is off, rather than
      // existing-but-refusing. See src/shared/build-flags.d.ts.
      if (__WINGLOG_CLOUD_SYNC_ENABLED__) {
        ipcMain.handle(IpcChannels.authLogin, (_event, email: string, password: string) =>
          cloudSync.login(email, password)
        )
        ipcMain.handle(
          IpcChannels.authSignup,
          (_event, email: string, password: string, inviteCode: string) =>
            cloudSync.signup(email, password, inviteCode)
        )
        ipcMain.handle(IpcChannels.authLogout, () => cloudSync.logout())
        ipcMain.handle(IpcChannels.syncNow, () => cloudSync.syncNow())
        ipcMain.handle(IpcChannels.syncStatus, () => cloudSync.getStatus())
      }

      // Update check (flightdeck-backend's docs/plans/update-check.md, Part A; agreed
      // 2026-10-02): asks GitHub for the latest published release, on by default, switchable
      // off in Settings → About. The endpoint can only be overridden in an unpackaged build,
      // for the Playwright acceptance test's fake release server.
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
      app.on('before-quit', () => updateService.stop())
      registerSettingsHandlers(ipcMain, { db, trackingController })
      registerAppHandlers(ipcMain, { updateService })

      // Navdata (Phase 3, flightdeck-backend's docs/plans/navdata-without-navigraph.md) — its
      // own short-lived SimConnect connection per refresh, deliberately separate from
      // simConnectService's live tracking connection (docs/navdata-notes.md's isolation
      // finding). refreshAirport is the only channel that touches the sim; the rest are cache
      // reads, so a Dispatch dropdown never blocks on a live SimConnect round-trip.
      const navdataProvider: NavdataProvider = new SimFacilitiesProvider(db)
      ipcMain.handle(IpcChannels.navdataRefreshAirport, (_event, icao: string) =>
        navdataProvider.refreshAirport(icao)
      )
      ipcMain.handle(IpcChannels.navdataHasAirport, (_event, icao: string) =>
        navdataProvider.hasAirport(icao)
      )
      ipcMain.handle(IpcChannels.navdataListRunways, (_event, icao: string) =>
        navdataProvider.listRunways(icao)
      )
      ipcMain.handle(IpcChannels.navdataListSids, (_event, icao: string, runway?: string | null) =>
        navdataProvider.listSids(icao, runway)
      )
      ipcMain.handle(IpcChannels.navdataListStars, (_event, icao: string, runway?: string | null) =>
        navdataProvider.listStars(icao, runway)
      )
      ipcMain.handle(IpcChannels.navdataListApproaches, (_event, icao: string, runway?: string | null) =>
        navdataProvider.listApproaches(icao, runway)
      )
      ipcMain.handle(
        IpcChannels.navdataGetProcedureWaypoints,
        (
          _event,
          icao: string,
          kind: NavdataProcedureKind,
          identifier: string,
          runway?: string | null,
          transition?: string | null
        ) => navdataProvider.getProcedureWaypoints(icao, kind, identifier, runway, transition)
      )
      ipcMain.handle(IpcChannels.navdataRefreshTaxiNetwork, (_event, icao: string) =>
        navdataProvider.refreshTaxiNetwork(icao)
      )
      ipcMain.handle(IpcChannels.navdataHasTaxiNetwork, (_event, icao: string) =>
        navdataProvider.hasTaxiNetwork(icao)
      )
      ipcMain.handle(IpcChannels.navdataGetTaxiNetwork, (_event, icao: string) =>
        navdataProvider.getTaxiNetwork(icao)
      )
      ipcMain.handle(IpcChannels.navdataGetStands, (_event, icao: unknown) =>
        typeof icao === 'string' && /^[A-Z0-9]{3,4}$/i.test(icao) ? navdataProvider.getStands(icao.toUpperCase()) : []
      )
      // Where each flight finished (stand-positions.md) — after completion, best effort.
      trackingController.on('completed', (flightId: number) => {
        const telemetry = simConnectService.getLastTelemetry()
        void recordParkedStand(
          {
            getArrivalIcao: (id) => getFlight(db, id)?.arrIcao ?? null,
            getStands: (icao) => navdataProvider.getStands(icao),
            setParkedStand: (id, icao, stand) => setParkedStand(db, id, icao, stand)
          },
          flightId,
          telemetry ? { lat: telemetry.latitude, lon: telemetry.longitude } : null
        ).catch((err: unknown) => console.warn('parked stand not recorded:', err))
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
    })
    .catch((error: unknown) => {
      // Without this, a startup failure (e.g. a missing/broken migration) leaves the process
      // running with no window and no visible error — indistinguishable from "still loading"
      // until someone goes looking for it. A native dialog is the one thing guaranteed to work
      // even if nothing else in the app initialized. console.error is routed to the log file by
      // initLogger() above, so this failure is captured for a bug report too, not just shown once.
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
      console.error('WingLog failed to start:', message)
      dialog.showErrorBox(t('startupFailed'), message)
      app.exit(1)
    })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
