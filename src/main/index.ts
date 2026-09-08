import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { initLogger } from './logging/logger'
import { backupDatabaseOnLaunch } from './db/backup'
import {
  IpcChannels,
  type AircraftUpdate,
  type AltitudeUnit,
  type WindSpeedUnit,
  type DispatchOfp,
  type DispatchOpenSimBriefParams,
  type GsxSettings,
  type LandingThresholds,
  type NavdataProcedureKind,
  type NewFlight,
  type ProcedureSelection,
  type Theme,
  type WeightUnit
} from '@shared/ipc'
import { fetchAircraftByRegistration } from './aircraft-lookup/adsbdb-client'
import { searchAircraftTypes } from './aircraft-lookup/icao-types'
import { findAirlineByIcao, searchAirlines } from './airlines/airline-search'
import { fetchMetars } from './weather/metar-client'
import { fetchExchangeRate } from './fx/fx-client'
import { greatCircleWaypoints, searchAirports } from './airports/airport-search'
import { createDb } from './db/client'
import { migrateDb } from './db/migrate'
import { migrateLegacyUserData } from './db/legacy-userdata'
import {
  createAircraft,
  deleteAircraft,
  getAircraftByRegistration,
  listAircraft,
  replaceAircraft,
  updateAircraft
} from './db/aircraft-repo'
import { parseAircraftInput } from './db/aircraft-validation'
import { exportAircraft, importAircraft } from './db/aircraft-import-export'
import { addInvoicesForFlight, listInvoicesForFlight } from './db/flight-invoice-repo'
import {
  abandonAllPlanned,
  abandonFlight,
  createFlight,
  deleteFlight,
  getActiveFlight,
  getFleetStats,
  getFlight,
  getInProgressFlight,
  getLogbookStats,
  listCompletedFlights,
  listFlights,
  listFlightsByAircraft
} from './db/flight-repo'
import { getLandingByFlight, listLandingsByAircraft } from './db/landing-repo'
import { importLogbookCsv } from './db/logbook-import'
import {
  getAltitudeUnit,
  getGsxSettings,
  getLandingThresholds,
  getSimbriefUsername,
  getTheme,
  getWeightUnit,
  getWindSpeedUnit,
  setAltitudeUnit,
  setGsxSettings,
  setLandingThresholds,
  setSimbriefUsername,
  setTheme,
  setWeightUnit,
  setWindSpeedUnit
} from './db/settings-repo'
import { listTrackPoints } from './db/track-point-repo'
import { simplifyTrackPoints } from './tracking/track-simplify'
import { defaultGsxReceiptsPath } from './gsx/default-path'
import { checkGsxFirstLaunch } from './gsx/first-launch-check'
import { buildFlightMatchWindow } from './gsx/flight-window'
import { readReceipt, receiptFileFromPath, scanGsxFolder } from './gsx/scan'
import { fetchAirframesForType } from './simbrief/simbrief-airframes'
import { extractOfpPdfUrl } from './simbrief/ofp-pdf'
import { fetchLatestOfp, parseOfp, type SimBriefOfp } from './simbrief/simbrief-client'
import {
  createCustomAirframeFromShare,
  fetchSimbriefUsername,
  generateOfp,
  isSimbriefLoggedIn,
  loginToSimbrief,
  logoutOfSimbrief
} from './simbrief/simbrief-generate'
import { SimConnectService } from './sim/SimConnectService'
import type { NavdataProvider } from './navdata/navdata-provider'
import { SimFacilitiesProvider } from './navdata/sim-facilities-provider'
import { TrackingController } from './tracking/TrackingController'
import { AutoStartDetector } from './tracking/AutoStartDetector'
import { CloudSyncController } from './sync/cloud-sync-controller'

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

      // No native menu bar — in-app navigation (the top tab bar in App.tsx) is the only
      // way to move around; a bare File/Edit/Window bar above it was clutter, not useful.
      Menu.setApplicationMenu(null)
      const window = createWindow()

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

      ipcMain.handle(IpcChannels.aircraftList, () => listAircraft(db))

      ipcMain.handle(IpcChannels.aircraftCreate, (_event, input: unknown) => {
        const result = parseAircraftInput(input)
        if ('error' in result) throw new Error(result.error)
        const created = createAircraft(db, result.data)
        scheduleBackgroundSync()
        return created
      })

      ipcMain.handle(IpcChannels.aircraftUpdate, (_event, input: AircraftUpdate) => {
        const { id, ...rest } = input
        const result = parseAircraftInput(rest)
        if ('error' in result) throw new Error(result.error)
        const updated = updateAircraft(db, { id, ...result.data })
        if (!updated) throw new Error(`Aircraft ${id} not found`)
        scheduleBackgroundSync()
        return updated
      })

      ipcMain.handle(IpcChannels.aircraftDelete, (_event, id: number) => {
        deleteAircraft(db, id)
        scheduleBackgroundSync()
      })

      ipcMain.handle(IpcChannels.aircraftReplace, (_event, retiredId: number, replacementId: number) => {
        replaceAircraft(db, { retiredId, replacementId })
        scheduleBackgroundSync()
      })

      ipcMain.handle(IpcChannels.aircraftImport, async () => {
        const summary = await importAircraft(db, window)
        if (summary) scheduleBackgroundSync()
        return summary
      })
      ipcMain.handle(IpcChannels.aircraftExport, () => exportAircraft(db, window))

      ipcMain.handle(IpcChannels.flightList, () => listFlights(db))

      function mapOfpForIpc(ofp: SimBriefOfp): DispatchOfp {
        const matched = getAircraftByRegistration(db, ofp.aircraftRegistration)
        const { rawJson, ...rest } = ofp
        return { ...rest, ofpJson: rawJson, matchedAircraftId: matched?.id ?? null }
      }

      ipcMain.handle(IpcChannels.dispatchFetchOfp, async (): Promise<DispatchOfp> => {
        const username = getSimbriefUsername(db)
        if (!username) throw new Error('Set your SimBrief username first')
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
          if (!username) throw new Error('Set your SimBrief username first')

          // Baseline for the "did a new plan actually appear" check below — best-effort, a
          // pilot with no prior OFP at all is a valid starting state, not an error.
          const baselineOfpId = await fetchLatestOfp(username)
            .then((ofp) => ofp.ofpId)
            .catch(() => null)

          await generateOfp(params)

          const ofp = await fetchLatestOfp(username)
          if (ofp.ofpId === baselineOfpId) {
            throw new Error('No new plan was generated — the window may have been closed before finishing')
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

      ipcMain.handle(IpcChannels.settingsGetSimbriefUsername, () => getSimbriefUsername(db) ?? null)
      ipcMain.handle(IpcChannels.settingsSetSimbriefUsername, (_event, username: string) =>
        setSimbriefUsername(db, username)
      )
      // Always true now — generation goes through flightdeck-backend rather than a per-build
      // key, so there's no "build with no key baked in" case to fall back from anymore. Kept
      // as a channel (rather than removing it and the renderer's "Plan on SimBrief…" fallback
      // entirely) in case a future bring-your-own-key or backend-downtime path wants it back.
      ipcMain.handle(IpcChannels.dispatchGenerationAvailable, () => true)

      ipcMain.handle(IpcChannels.settingsGetWeightUnit, () => getWeightUnit(db))
      ipcMain.handle(IpcChannels.settingsSetWeightUnit, (_event, unit: WeightUnit) => setWeightUnit(db, unit))
      ipcMain.handle(IpcChannels.settingsGetAltitudeUnit, () => getAltitudeUnit(db))
      ipcMain.handle(IpcChannels.settingsSetAltitudeUnit, (_event, unit: AltitudeUnit) =>
        setAltitudeUnit(db, unit)
      )
      ipcMain.handle(IpcChannels.settingsGetWindSpeedUnit, () => getWindSpeedUnit(db))
      ipcMain.handle(IpcChannels.settingsSetWindSpeedUnit, (_event, unit: WindSpeedUnit) =>
        setWindSpeedUnit(db, unit)
      )
      ipcMain.handle(IpcChannels.settingsGetTheme, () => getTheme(db))
      ipcMain.handle(IpcChannels.settingsSetTheme, (_event, theme: Theme) => setTheme(db, theme))

      const simConnectService = new SimConnectService()
      ipcMain.handle(IpcChannels.simConnectionStatusGet, () => simConnectService.getStatus())
      simConnectService.on('telemetry', (telemetry) => {
        if (!window.isDestroyed()) window.webContents.send(IpcChannels.simTelemetry, telemetry)
      })
      simConnectService.on('status', (status) => {
        if (!window.isDestroyed()) window.webContents.send(IpcChannels.simConnectionStatus, status)
      })
      simConnectService.start()
      app.on('before-quit', () => simConnectService.stop())

      const trackingController = new TrackingController(db, simConnectService)
      // The previous process quit or crashed before this flight reached 'completed' or
      // 'abandoned' — its DB row (OFP, route, everything Track's map needs) was never at
      // risk, only the in-memory phase-detection state tracking it was lost with that process.
      // Left as a choice for the user (not auto-resumed) since "pick tracking back up" is only
      // right if the flight's actually still going in the sim — captured once here, at
      // startup, and cleared the moment the renderer answers the resume/discard prompt this
      // drives (trackingGetOrphanedFlight/trackingResumeOrphaned/trackingDiscardOrphaned below).
      let orphanedActiveFlight = getActiveFlight(db)

      trackingController.on('point', (point) => {
        if (!window.isDestroyed()) window.webContents.send(IpcChannels.trackingPoint, point)
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
        try {
          trackingController.start(flightId)
        } catch {
          // The flight may have been cancelled, or already started via the manual button,
          // between arming and this firing — safe to ignore either way.
        }
      })

      ipcMain.handle(IpcChannels.trackingStart, (_event, flightId: number) => {
        autoStartDetector.disarm()
        trackingController.start(flightId)
      })
      ipcMain.handle(IpcChannels.trackingStop, () => trackingController.stop())
      ipcMain.handle(IpcChannels.trackingFinish, () => trackingController.finish())
      ipcMain.handle(IpcChannels.trackingGetActive, () => trackingController.getActive() ?? null)
      ipcMain.handle(IpcChannels.trackingSetProcedureSelection, (_event, selection: ProcedureSelection) =>
        trackingController.setProcedureSelection(selection)
      )
      ipcMain.handle(IpcChannels.trackingGetOrphanedFlight, () => orphanedActiveFlight ?? null)
      ipcMain.handle(IpcChannels.trackingResumeOrphaned, (_event, flightId: number) => {
        if (orphanedActiveFlight?.id !== flightId) return
        trackingController.resume(flightId)
        orphanedActiveFlight = undefined
      })
      ipcMain.handle(IpcChannels.trackingDiscardOrphaned, (_event, flightId: number) => {
        if (orphanedActiveFlight?.id !== flightId) return
        abandonFlight(db, flightId)
        orphanedActiveFlight = undefined
        scheduleBackgroundSync()
      })
      // Simplified for both callers (Logbook review and TrackView's resume-an-in-progress-
      // flight catch-up load) — storage itself stays full resolution regardless, this only
      // shapes what crosses IPC and gets rendered. Live tracking's own point-by-point stream
      // (the 'point' event below) is completely separate and unaffected.
      ipcMain.handle(IpcChannels.trackPointList, (_event, flightId: number) =>
        simplifyTrackPoints(listTrackPoints(db, flightId))
      )

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

      ipcMain.handle(IpcChannels.logbookListCompletedFlights, () => listCompletedFlights(db))
      ipcMain.handle(IpcChannels.logbookGetStats, () => getLogbookStats(db))
      ipcMain.handle(IpcChannels.logbookFleetStats, () => getFleetStats(db))
      ipcMain.handle(IpcChannels.logbookImportCsv, async () => {
        const summary = await importLogbookCsv(db, window)
        if (summary) scheduleBackgroundSync()
        return summary
      })
      ipcMain.handle(IpcChannels.logbookListInvoices, (_event, flightId: number) =>
        listInvoicesForFlight(db, flightId)
      )

      // GSX ground-service invoices (docs/decisions.md, gsx-invoices entry) — opt-in, off by
      // default, and a no-op everywhere below when disabled or unconfigured. Windows-only in
      // practice (GSX itself is Windows-only), but nothing here assumes that beyond
      // defaultGsxReceiptsPath returning null elsewhere.
      ipcMain.handle(IpcChannels.settingsGetGsx, () => getGsxSettings(db))
      ipcMain.handle(IpcChannels.settingsSetGsx, (_event, settings: GsxSettings) =>
        setGsxSettings(db, settings)
      )
      ipcMain.handle(IpcChannels.settingsCheckGsxFirstLaunch, () => checkGsxFirstLaunch(db))

      ipcMain.handle(IpcChannels.gsxBrowseFolder, async () => {
        const { canceled, filePaths } = await dialog.showOpenDialog(window, {
          title: 'GSX receipts folder',
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

      ipcMain.handle(IpcChannels.logbookOpenOfpPdf, async (_event, flightId: number) => {
        const flight = getFlight(db, flightId)
        const url = flight ? extractOfpPdfUrl(flight.ofpJson) : null
        if (!url) return false
        await shell.openExternal(url)
        return true
      })

      ipcMain.handle(
        IpcChannels.logbookGetLanding,
        (_event, flightId: number) => getLandingByFlight(db, flightId) ?? null
      )
      ipcMain.handle(IpcChannels.logbookGreatCircleRoute, (_event, depIcao: string, arrIcao: string) =>
        greatCircleWaypoints(depIcao, arrIcao)
      )
      ipcMain.handle(IpcChannels.fleetListLandings, (_event, aircraftId: number) =>
        listLandingsByAircraft(db, aircraftId)
      )
      ipcMain.handle(IpcChannels.fleetListFlights, (_event, aircraftId: number) =>
        listFlightsByAircraft(db, aircraftId)
      )
      ipcMain.handle(IpcChannels.settingsGetLandingThresholds, () => getLandingThresholds(db))
      ipcMain.handle(IpcChannels.settingsSetLandingThresholds, (_event, thresholds: LandingThresholds) =>
        setLandingThresholds(db, thresholds)
      )

      ipcMain.handle(IpcChannels.aircraftLookupByRegistration, (_event, registration: string) =>
        fetchAircraftByRegistration(registration)
      )
      ipcMain.handle(IpcChannels.aircraftTypeSearch, (_event, query: string) => searchAircraftTypes(query))
      ipcMain.handle(IpcChannels.simbriefAirframesForType, (_event, icaoType: string) =>
        fetchAirframesForType(icaoType)
      )
      ipcMain.handle(IpcChannels.simbriefCreateCustomAirframe, (_event, shareUrl: string) =>
        createCustomAirframeFromShare(shareUrl)
      )
      ipcMain.handle(IpcChannels.airportSearch, (_event, query: string) => searchAirports(query))
      ipcMain.handle(IpcChannels.airlineSearch, (_event, query: string) => searchAirlines(query))
      ipcMain.handle(IpcChannels.airlineFindByIcao, (_event, icao: string) => findAirlineByIcao(icao))
      ipcMain.handle(IpcChannels.weatherGetMetars, (_event, icaoCodes: string[]) => fetchMetars(icaoCodes))
      ipcMain.handle(IpcChannels.fxGetRate, (_event, targetCurrency: string, date?: string) =>
        fetchExchangeRate(targetCurrency, date)
      )

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

      ipcMain.handle(IpcChannels.appGetVersion, () => app.getVersion())
      ipcMain.handle(IpcChannels.appOpenGithub, () =>
        shell.openExternal('https://github.com/Catalyst4K/WingLog')
      )

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
      dialog.showErrorBox('WingLog failed to start', message)
      app.exit(1)
    })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
