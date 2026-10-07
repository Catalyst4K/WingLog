/**
 * Logbook IPC: completed flights, their landings, tracks, receipts and OFPs, the statistics, and
 * logbook import and export. Every channel is a query (coding-standards.md §9): plain IPC to the
 * local database.
 */
import { shell, type BrowserWindow, type IpcMain } from 'electron'
import { IpcChannels } from '@shared/ipc'
import type { WingLogDb } from '../db/client'
import { asDataFormat } from './data-format'
import {
  listFlights,
  listCompletedFlights,
  getLiveFlight,
  getLogbookStats,
  getFleetStats,
  getFlight,
  setFlownRoute
} from '../db/flight-repo'
import { importLogbookCsv, importLogbookJson, exportLogbook } from '../db/logbook-import'
import { listInvoicesForFlight } from '../db/flight-invoice-repo'
import { extractOfpPdfUrl } from '../simbrief/ofp-pdf'
import { getAircraftById } from '../db/aircraft-repo'
import { listLandingsByFlight, listAllLandings } from '../db/landing-repo'
import { findLandingRunway } from '../airports/runway-lookup'
import { resolveLandingScore, getLandingScoresForCompletedFlights } from '../db/landing-score-resolver'
import { greatCircleWaypoints } from '../airports/airport-search'
import { simplifyTrackPoints } from '../tracking/track-simplify'
import { listTrackPoints } from '../db/track-point-repo'
import { runTrackCleanupForFlight } from '../db/run-track-cleanup'
import { deriveFlownRouteJson } from '../tracking/route-simplify'

/** What the logbook channels need. */
export interface LogbookHandlerDeps {
  db: WingLogDb
  /** The window file dialogs open over. */
  window: BrowserWindow
  /** Pushes a change to the cloud copy, when signed in. */
  scheduleBackgroundSync: () => void
}

/**
 * Registers the logbook channels.
 *
 * @param ipcMain Electron's IPC.
 * @param deps The database, the window and the background sync.
 */
export function registerLogbookHandlers(
  ipcMain: IpcMain,
  { db, window, scheduleBackgroundSync }: LogbookHandlerDeps
): void {
  ipcMain.handle(IpcChannels.flightList, () => listFlights(db))

  ipcMain.handle(IpcChannels.logbookListCompletedFlights, () => listCompletedFlights(db))

  ipcMain.handle(IpcChannels.logbookGetFlight, (_event, id: unknown) => {
    if (typeof id !== 'number' || !Number.isInteger(id)) return null
    return getLiveFlight(db, id) ?? null
  })

  ipcMain.handle(IpcChannels.logbookGetStats, () => getLogbookStats(db))

  ipcMain.handle(IpcChannels.logbookFleetStats, () => getFleetStats(db))

  ipcMain.handle(IpcChannels.logbookImportCsv, async () => {
    const summary = await importLogbookCsv(db, window)
    if (summary) scheduleBackgroundSync()
    return summary
  })

  ipcMain.handle(IpcChannels.logbookImportJson, async () => {
    const summary = await importLogbookJson(db, window)
    if (summary) scheduleBackgroundSync()
    return summary
  })

  ipcMain.handle(IpcChannels.logbookExport, (_event, format?: unknown) =>
    exportLogbook(db, window, asDataFormat(format))
  )

  ipcMain.handle(IpcChannels.logbookListInvoices, (_event, flightId: number) =>
    listInvoicesForFlight(db, flightId)
  )

  ipcMain.handle(IpcChannels.logbookOpenOfpPdf, async (_event, flightId: number) => {
    const flight = getFlight(db, flightId)
    const url = flight ? extractOfpPdfUrl(flight.ofpJson) : null
    if (!url) return false
    await shell.openExternal(url)
    return true
  })

  ipcMain.handle(IpcChannels.logbookListLandings, (_event, flightId: number) => {
    const landingFlight = getFlight(db, flightId)
    if (!landingFlight) return []
    const icaoType =
      landingFlight.aircraftId != null
        ? (getAircraftById(db, landingFlight.aircraftId)?.icaoType ?? null)
        : landingFlight.simIcaoType
    return listLandingsByFlight(db, flightId).map((landingRecord) => {
      // This touchdown's own resolved airport, falling back to the flight's filed
      // arrival — same icao the capture itself narrowed the runway search by
      // (TrackingController), so the read side can never disagree with what was
      // actually measured.
      const icao = landingRecord.icao ?? landingFlight.arrIcao
      return {
        ...landingRecord,
        runway: landingRecord.runwayIdent ? findLandingRunway(icao, landingRecord.runwayIdent) : null,
        score: resolveLandingScore(landingRecord, icao, icaoType)
      }
    })
  })

  ipcMain.handle(IpcChannels.logbookListAllLandings, () =>
    listAllLandings(db).map(({ icaoType, ...row }) => {
      const icao = row.icao ?? row.arrIcao
      const { score, severity } = resolveLandingScore(row, icao, icaoType)
      return { ...row, score, severity }
    })
  )

  ipcMain.handle(IpcChannels.logbookListFlightScores, () => getLandingScoresForCompletedFlights(db))

  ipcMain.handle(IpcChannels.logbookGreatCircleRoute, (_event, depIcao: string, arrIcao: string) =>
    greatCircleWaypoints(depIcao, arrIcao)
  )

  // Simplified for both callers (Logbook review and TrackView's resume-an-in-progress-
  // flight catch-up load) — storage itself stays full resolution regardless, this only
  // shapes what crosses IPC and gets rendered. Live tracking's own point-by-point stream
  // (the 'point' event below) is completely separate and unaffected.
  ipcMain.handle(IpcChannels.trackPointList, (_event, flightId: number) =>
    simplifyTrackPoints(listTrackPoints(db, flightId).filter((p) => p.excludedReason == null))
  )

  // Logbook's manual "Clean up track" button (winglog-backend's docs/plans/done/
  // resume-track-cleanup.md) — the same cleanup pass TrackingController already runs
  // live/at completion, run on demand for a flight with no active recorder at all
  // (one completed before Phase 2 existed, or the rare case the live check missed
  // something). Re-derives flownRouteJson from the now-corrected points afterward,
  // same as TrackingController.deriveFlownRoute does at completion, so a synced copy
  // doesn't keep the stale route — and syncs it, since track_point itself never syncs
  // but flownRouteJson does.
  ipcMain.handle(IpcChannels.trackPointCleanup, (_event, flightId: number) => {
    const result = runTrackCleanupForFlight(db, flightId)
    if (!result) return { excludedCount: 0, resegmentedCount: 0 }
    const points = listTrackPoints(db, flightId).filter((p) => p.excludedReason == null)
    const flownRouteJson = deriveFlownRouteJson(points)
    if (flownRouteJson) setFlownRoute(db, flightId, flownRouteJson)
    scheduleBackgroundSync()
    return { excludedCount: result.exclusions.length, resegmentedCount: result.segmentReassignments.length }
  })
}
