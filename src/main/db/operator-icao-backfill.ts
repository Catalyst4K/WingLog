/**
 * Fills in the operator ICAO of fleet aircraft that were saved with an airline name and IATA code but no ICAO. The column was added after the
 * name and the IATA code, and installed copies never had theirs filled; aircraft added from an older export arrive the same way. Dispatch fills
 * its Airline ICAO field from this column, so an aircraft without it left the field empty.
 */

import type { AirlineOption } from '@shared/ipc'
import type { WingLogDb } from './client'
import { fillMissingOperatorIcao, listAircraft } from './aircraft-repo'

/** Looks an aircraft's operator up in the airline list. */
export type OperatorFinder = (operator: string | null, iata: string | null) => AirlineOption | undefined

/**
 * Sets `operatorIcao` on every live aircraft that has an IATA code, no ICAO, and exactly one airline that fits. Leaves the rest alone: a name
 * with no code is never turned into one, and an airline the list cannot place has nothing to recover from. The write does not count as an edit
 * for sync (see `fillMissingOperatorIcao`). Safe to run on every start: once filled, an aircraft is not touched again.
 *
 * @param db The database.
 * @param find How an operator is looked up (the vendored list; a fake in tests).
 * @returns The registrations that were filled.
 */
export function backfillOperatorIcao(db: WingLogDb, find: OperatorFinder): string[] {
  const filled: string[] = []
  for (const aircraft of listAircraft(db)) {
    if (aircraft.operatorIcao || !aircraft.operatorIata) continue
    const match = find(aircraft.operator, aircraft.operatorIata)
    if (match && fillMissingOperatorIcao(db, aircraft.id, match.icao)) filled.push(aircraft.registration)
  }
  return filled
}
