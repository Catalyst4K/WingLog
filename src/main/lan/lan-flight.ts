/** What the second-screen server tells a device about the flight, read-only and assembled here so no database handle crosses. */

import type { LanFlightSnapshot } from '@shared/ipc'
import type { WingLogDb } from '../db/client'
import { getLiveFlight } from '../db/flight-repo'
import { listTrackPoints } from '../db/track-point-repo'

/**
 * @param db The database.
 * @param activeFlightId The flight being tracked, if any.
 * @returns The active flight with its recorded track, or null when none is being tracked.
 */
export function lanFlightSnapshot(
  db: WingLogDb,
  activeFlightId: number | undefined
): LanFlightSnapshot | null {
  if (activeFlightId === undefined) return null
  const flight = getLiveFlight(db, activeFlightId)
  if (!flight) return null
  return {
    flight: {
      flightId: flight.id,
      depIcao: flight.depIcao,
      arrIcao: flight.arrIcao,
      ofpJson: flight.ofpJson
    },
    trackPoints: listTrackPoints(db, flight.id)
  }
}
