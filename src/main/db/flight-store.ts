/**
 * The app's FlightStore (src/main/tracking/flight-store.ts): tracking's logbook operations on the
 * local database, through the repos.
 */
import type { FlightStore } from '../tracking/flight-store'
import { buildFlightMatchWindow } from './gsx-flight-window'
import { scanGsxFolder } from '../gsx/scan'
import { logger } from '../logging/logger'
import type { WingLogDb } from './client'
import { addInvoicesForFlight } from './flight-invoice-repo'
import {
  abandonFlight,
  completeFlight,
  createFreeFlight,
  finalizeFuelOut,
  getFlight,
  recordOff,
  recordOn,
  setArrIcao,
  setDepIcao,
  setFlownRoute,
  startFlight
} from './flight-repo'
import { createLanding, listLandingsByFlight } from './landing-repo'
import { listCachedRunways } from './navdata-repo'
import { runTrackCleanupForFlight } from './run-track-cleanup'
import { getGsxSettings, rememberAircraftForTitle } from './settings-repo'
import { createTrackPoint, listTrackPoints } from './track-point-repo'

/**
 * Tracking's logbook on the local database.
 *
 * @param db The open database.
 * @param onWrite Called after each write to a flight or a landing, the rows other devices sync. It is the call every writer makes so
 *   a twin and the cloud hear of the change (`scheduleBackgroundSync`). Track points are not told: they travel once, with a completed flight.
 * @returns The store.
 */
export function dbFlightStore(db: WingLogDb, onWrite: () => void = () => {}): FlightStore {
  /**
   * Runs a write to a synced row, then tells `onWrite`.
   *
   * @param write The write.
   * @returns What the write returned.
   */
  const written = <T>(write: () => T): T => {
    const result = write()
    onWrite()
    return result
  }
  return {
    getFlight: (flightId) => getFlight(db, flightId),
    startFlight: (flightId, fuelOutKg) => written(() => void startFlight(db, flightId, fuelOutKg)),
    createFreeFlight: (input) => written(() => createFreeFlight(db, input)),
    abandonFlight: (flightId) => written(() => abandonFlight(db, flightId)),
    finalizeFuelOut: (flightId, fuelOutKg) => written(() => void finalizeFuelOut(db, flightId, fuelOutKg)),
    recordOff: (flightId) => written(() => void recordOff(db, flightId)),
    recordOn: (flightId) => written(() => void recordOn(db, flightId)),
    completeFlight: (flightId, fuelInKg, pausedIntervals) =>
      written(() => void completeFlight(db, flightId, fuelInKg, pausedIntervals)),
    setArrIcao: (flightId, icao) => written(() => setArrIcao(db, flightId, icao)),
    setDepIcao: (flightId, icao) => written(() => setDepIcao(db, flightId, icao)),
    setFlownRoute: (flightId, json) => written(() => setFlownRoute(db, flightId, json)),
    addTrackPoint: (point) => createTrackPoint(db, point),
    listTrackPoints: (flightId) => listTrackPoints(db, flightId),
    addLanding: (landing) => written(() => void createLanding(db, landing)),
    countLandings: (flightId) => listLandingsByFlight(db, flightId).length,
    listRunways: (icao) => listCachedRunways(db, icao),
    rememberAircraftForTitle: (title, aircraftId) => rememberAircraftForTitle(db, title, aircraftId),
    cleanUpTrack: (flightId) => runTrackCleanupForFlight(db, flightId),
    saveGsxInvoices: (flightId) => {
      const settings = getGsxSettings(db)
      if (!settings.enabled || !settings.folderPath) return
      const window = buildFlightMatchWindow(db, flightId)
      if (!window) return
      scanGsxFolder(settings.folderPath, window)
        .then((result) => addInvoicesForFlight(db, flightId, result.matched))
        // Best effort after completion: a missing or renamed folder, or a malformed receipt, must
        // never affect the flight; the Logbook's rescan covers anything missed.
        .catch((error: unknown) =>
          logger.warn(`[gsx] receipt scan after flight ${flightId} failed: ${String(error)}`)
        )
    }
  }
}
