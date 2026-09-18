import { getAircraftById } from '../db/aircraft-repo'
import type { WingLogDb } from '../db/client'
import { getFlight } from '../db/flight-repo'
import type { FlightMatchWindow } from './matcher'

/** Builds the tail/ICAO/time-window a GSX scan needs to match receipts to a flight —
 *  shared by the completion-time snapshot and the manual rescan/attach IPC handlers, so
 *  they can never disagree about what "this flight's window" means. Falls back to
 *  scheduled times when actual ones aren't recorded yet (e.g. rescanning a planned
 *  flight), and returns null for a flight or aircraft that no longer exists — or, for a
 *  free flight tracked with no fleet aircraft, one with no sim-reported registration
 *  either (shouldn't happen in practice, since the dialog requires one). */
export function buildFlightMatchWindow(db: WingLogDb, flightId: number): FlightMatchWindow | null {
  const flight = getFlight(db, flightId)
  if (!flight) return null
  const registration = flight.aircraftId != null ? getAircraftById(db, flight.aircraftId)?.registration : flight.simRegistration
  if (!registration) return null

  return {
    depIcao: flight.depIcao,
    arrIcao: flight.arrIcao,
    registration,
    windowStartUtc: flight.actualOutUtc ?? flight.schedOutUtc,
    windowEndUtc: flight.actualInUtc ?? flight.schedInUtc
  }
}
