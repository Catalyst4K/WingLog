/**
 * The app's FlightStore (src/main/tracking/flight-store.ts): tracking's logbook operations on the
 * local database, through the repos.
 */
import type { FlightStore } from '../tracking/flight-store'
import { buildFlightMatchWindow } from './gsx-flight-window'
import { scanGsxFolder } from '../gsx/scan'
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
  setSelectedProcedures,
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
 * @returns The store.
 */
export function dbFlightStore(db: WingLogDb): FlightStore {
  return {
    getFlight: (flightId) => getFlight(db, flightId),
    startFlight: (flightId, fuelOutKg) => void startFlight(db, flightId, fuelOutKg),
    createFreeFlight: (input) => createFreeFlight(db, input),
    abandonFlight: (flightId) => abandonFlight(db, flightId),
    finalizeFuelOut: (flightId, fuelOutKg) => void finalizeFuelOut(db, flightId, fuelOutKg),
    recordOff: (flightId) => void recordOff(db, flightId),
    recordOn: (flightId) => void recordOn(db, flightId),
    completeFlight: (flightId, fuelInKg, pausedIntervals) => void completeFlight(db, flightId, fuelInKg, pausedIntervals),
    setArrIcao: (flightId, icao) => setArrIcao(db, flightId, icao),
    setDepIcao: (flightId, icao) => setDepIcao(db, flightId, icao),
    setFlownRoute: (flightId, json) => setFlownRoute(db, flightId, json),
    setSelectedProcedures: (flightId, selection) => setSelectedProcedures(db, flightId, selection),
    addTrackPoint: (point) => createTrackPoint(db, point),
    listTrackPoints: (flightId) => listTrackPoints(db, flightId),
    addLanding: (landing) => void createLanding(db, landing),
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
        .catch(() => undefined)
    }
  }
}
