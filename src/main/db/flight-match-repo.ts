/** Finding a flight by what it is rather than by its uuid, for sync (flight-repo.ts is at its size limit). */

import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import type { WingLogDb } from './client'
import { flight } from './schema'

/**
 * The live flight with the same route and the same actual out-time: the same real flight, whatever uuid each device gave it. Two devices that
 * were each set up from the same history (an import, a restore) hold the same flights under different uuids, and sync would otherwise add
 * every one of them a second time. Only a flight that has gone out can be told apart this way, so a planned one never matches.
 *
 * @param db The database.
 * @param depIcao The departure airport.
 * @param arrIcao The arrival airport.
 * @param actualOutUtc When it went off blocks.
 * @returns The flight's uuid and aircraft, or undefined when there is none.
 */
export function findLiveFlightByContent(
  db: WingLogDb,
  depIcao: string,
  arrIcao: string,
  actualOutUtc: string
): { uuid: string; aircraftId: number | null } | undefined {
  const row = db
    .select({ uuid: flight.uuid, aircraftId: flight.aircraftId })
    .from(flight)
    .where(
      and(
        eq(flight.depIcao, depIcao),
        eq(flight.arrIcao, arrIcao),
        eq(flight.actualOutUtc, actualOutUtc),
        isNull(flight.deletedAt),
        isNotNull(flight.uuid)
      )
    )
    .orderBy(flight.id)
    .get()
  return row?.uuid ? { uuid: row.uuid, aircraftId: row.aircraftId } : undefined
}
