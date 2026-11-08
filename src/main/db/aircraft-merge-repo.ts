/**
 * Folding a second copy of an aircraft into the first, for sync. An aircraft renamed on one device (B-HNR to B-KQH) is not matched to the
 * other device's copy by registration, so it arrives as a new, empty aircraft; the flights that both devices hold then show it is the same
 * aircraft (sync-engine.ts applyFlight).
 */

import { and, eq, isNull, like } from 'drizzle-orm'
import type { WingLogDb } from './client'
import { aircraft, appSetting, flight } from './schema'
import { setSetting } from './settings-repo'

/**
 * @param db The database.
 * @param uuid An aircraft's sync uuid.
 * @returns Its registration here, or undefined when there is no such aircraft.
 */
export function getAircraftRegistrationByUuid(db: WingLogDb, uuid: string): string | undefined {
  return db
    .select({ registration: aircraft.registration })
    .from(aircraft)
    .where(eq(aircraft.uuid, uuid))
    .get()?.registration
}

/**
 * Folds an aircraft with no flights of its own into another, and leaves an alias so a later row that names the folded one finds the other.
 * The folded row is deleted outright, not tombstoned: a tombstone would travel to the other device, where that uuid may be its real aircraft.
 * Does nothing when the aircraft is not an empty copy: it has a live flight, it has been replaced or has replaced another.
 *
 * @param db The database.
 * @param fromId The local aircraft that is only a second copy.
 * @param intoId The local aircraft it is a copy of.
 * @param incomingUuid The uuid the other device calls the copy by, when that is not the copy's own (it may already be an alias).
 * @returns True when the copy was folded in.
 */
export function mergeEmptyAircraft(
  db: WingLogDb,
  fromId: number,
  intoId: number,
  incomingUuid?: string
): boolean {
  if (fromId === intoId) return false
  const from = db.select().from(aircraft).where(eq(aircraft.id, fromId)).get()
  const into = db.select().from(aircraft).where(eq(aircraft.id, intoId)).get()
  if (!from?.uuid || !into?.uuid || from.deletedAt !== null || into.deletedAt !== null) return false
  if (from.replacedByAircraftId !== null) return false
  if (db.select({ id: aircraft.id }).from(aircraft).where(eq(aircraft.replacedByAircraftId, fromId)).get())
    return false
  if (
    db
      .select({ id: flight.id })
      .from(flight)
      .where(and(eq(flight.aircraftId, fromId), isNull(flight.deletedAt)))
      .get()
  )
    return false
  const fromUuid = from.uuid
  const intoUuid = into.uuid
  db.transaction((tx) => {
    // Deleted flights still point at the copy; they move too, or the delete would break their reference.
    tx.update(flight).set({ aircraftId: intoId }).where(eq(flight.aircraftId, fromId)).run()
    // Anything that already stood for the copy now stands for the aircraft it was folded into.
    tx.update(appSetting)
      .set({ value: intoUuid })
      .where(and(like(appSetting.key, 'aircraftAlias:%'), eq(appSetting.value, fromUuid)))
      .run()
    setSetting(tx, `aircraftAlias:${fromUuid}`, intoUuid)
    if (incomingUuid !== undefined) setSetting(tx, `aircraftAlias:${incomingUuid}`, intoUuid)
    tx.delete(aircraft).where(eq(aircraft.id, fromId)).run()
  })
  return true
}
