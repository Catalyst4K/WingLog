/** What the second-screen server tells a device about the flight, read-only and assembled here so no database handle crosses. */

import type { LanFlightSnapshot, ProcedureSelection } from '@shared/ipc'
import type { WingLogDb } from '../db/client'
import { getLiveAircraftById } from '../db/aircraft-repo'
import { getLiveFlight, listFlightSummaries } from '../db/flight-repo'
import { listTrackPoints } from '../db/track-point-repo'

/**
 * The flight a second screen shows: the one being tracked, otherwise the newest flight still only planned (as Track's own map previews it).
 *
 * @param db The database.
 * @param activeFlightId The flight being tracked, if any.
 * @returns The flight's id, or undefined when there is none.
 */
function shownFlightId(db: WingLogDb, activeFlightId: number | undefined): number | undefined {
  if (activeFlightId !== undefined) return activeFlightId
  return listFlightSummaries(db).find((f) => f.status === 'planned')?.id
}

/**
 * A short text that changes whenever the flight shown, or the flight itself, changes, so a connected device can be sent the new one.
 *
 * @param db The database.
 * @param activeFlightId The flight being tracked, if any.
 * @returns The key.
 */
export function lanFlightKey(db: WingLogDb, activeFlightId: number | undefined): string {
  const id = shownFlightId(db, activeFlightId)
  const flight = id === undefined ? undefined : getLiveFlight(db, id)
  return flight
    ? JSON.stringify([
        flight.id,
        flight.status,
        flight.ofpId,
        flight.flightNumber,
        flight.depIcao,
        flight.arrIcao,
        flight.selectedDepartureRunway,
        flight.selectedSidIdent,
        flight.selectedStarIdent,
        flight.selectedApproachIdent
      ])
    : 'none'
}

/**
 * @param db The database.
 * @param activeFlightId The flight being tracked, if any.
 * @param chosen The SID, STAR and approach the PC's own window last chose; the flight's saved choice when left out.
 * @returns The flight shown with its recorded track, or null when there is none.
 */
export function lanFlightSnapshot(
  db: WingLogDb,
  activeFlightId: number | undefined,
  chosen?: ProcedureSelection
): LanFlightSnapshot | null {
  const shownId = shownFlightId(db, activeFlightId)
  if (shownId === undefined) return null
  const flight = getLiveFlight(db, shownId)
  if (!flight) return null
  const aircraft = flight.aircraftId === null ? undefined : getLiveAircraftById(db, flight.aircraftId)
  return {
    flight: {
      flightId: flight.id,
      depIcao: flight.depIcao,
      arrIcao: flight.arrIcao,
      flightNumber: flight.flightNumber,
      schedInUtc: flight.schedInUtc,
      registration: aircraft?.registration ?? null,
      icaoType: aircraft?.icaoType ?? null,
      ofpJson: flight.ofpJson,
      selection: chosen ?? {
        departureRunway: flight.selectedDepartureRunway,
        sidIdent: flight.selectedSidIdent,
        sidTransition: flight.selectedSidTransition,
        starIdent: flight.selectedStarIdent,
        starTransition: flight.selectedStarTransition,
        approachIdent: flight.selectedApproachIdent,
        approachTransition: flight.selectedApproachTransition,
        arrivalIcao: flight.selectedArrivalIcao
      }
    },
    trackPoints: listTrackPoints(db, flight.id)
  }
}
