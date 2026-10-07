/**
 * The fleet in the database: creating, editing, replacing, retiring and deleting aircraft, and the
 * sync helpers. Deleting is a soft delete, refused while the aircraft still has flights.
 */
import { randomUUID } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import type { Aircraft, AircraftUpdate, NewAircraft } from '@shared/ipc'
import { t } from '../i18n'
import { aircraft, flight } from './schema'
import type { WingLogDb } from './client'
import { rowsChangedSince, shouldApplyPulledRow } from './sync-rows'

/**
 * A database row as an Aircraft.
 *
 * @param row The `aircraft` row.
 * @returns The aircraft as the app sees it.
 */
function toAircraft(row: typeof aircraft.$inferSelect): Aircraft {
  return {
    id: row.id,
    registration: row.registration,
    icaoType: row.icaoType,
    operator: row.operator,
    operatorIata: row.operatorIata,
    operatorIcao: row.operatorIcao,
    simbriefAirframeId: row.simbriefAirframeId,
    simbriefType: row.simbriefType,
    simbriefAirframeDeveloper: row.simbriefAirframeDeveloper,
    simbriefAirframeEngines: row.simbriefAirframeEngines,
    simbriefAirframeRegistration: row.simbriefAirframeRegistration,
    currentIcao: row.currentIcao,
    createdAt: row.createdAt,
    replacedByAircraftId: row.replacedByAircraftId,
    retiredAt: row.retiredAt,
    photoThumbnailUrl: row.photoThumbnailUrl
  }
}

/**
 * Every aircraft that isn't deleted.
 *
 * @param db The database.
 * @returns The aircraft, retired ones included.
 */
export function listAircraft(db: WingLogDb): Aircraft[] {
  return db.select().from(aircraft).where(isNull(aircraft.deletedAt)).all().map(toAircraft)
}

/** Filters out a soft-deleted aircraft — "is this registration already a live fleet
 *  aircraft", the semantic every caller actually wants (import dedup, OFP-to-fleet
 *  matching). One known edge case this doesn't solve: `registration` still carries a
 *  UNIQUE constraint at the schema level, so re-adding a registration that belonged to a
 *  now-deleted aircraft hits a raw constraint error on insert rather than a clean message —
 *  acceptable for how rarely aircraft are deleted at all, not solved here.
 *
 * @param db The database.
 * @param registration The registration, exactly as stored.
 * @returns The aircraft, or undefined.
 */
export function getAircraftByRegistration(db: WingLogDb, registration: string): Aircraft | undefined {
  const row = db
    .select()
    .from(aircraft)
    .where(and(eq(aircraft.registration, registration), isNull(aircraft.deletedAt)))
    .get()
  return row ? toAircraft(row) : undefined
}

/**
 * An aircraft by id, including a deleted one.
 *
 * @param db The database.
 * @param id The aircraft.
 * @returns The aircraft, or undefined.
 */
export function getAircraftById(db: WingLogDb, id: number): Aircraft | undefined {
  const row = db.select().from(aircraft).where(eq(aircraft.id, id)).get()
  return row ? toAircraft(row) : undefined
}

/**
 * An aircraft by id, never a deleted one: for checking an aircraft the renderer chose.
 *
 * @param db The database.
 * @param id The aircraft.
 * @returns The aircraft, or undefined when missing or deleted.
 */
export function getLiveAircraftById(db: WingLogDb, id: number): Aircraft | undefined {
  const row = db
    .select()
    .from(aircraft)
    .where(and(eq(aircraft.id, id), isNull(aircraft.deletedAt)))
    .get()
  return row ? toAircraft(row) : undefined
}

/**
 * See flight-repo.ts's getFlightIdByUuid for the shape/reasoning this mirrors.
 *
 * @param db The database.
 * @param uuid The aircraft's sync uuid.
 * @returns The local id, or undefined.
 */
export function getAircraftIdByUuid(db: WingLogDb, uuid: string): number | undefined {
  return db.select({ id: aircraft.id }).from(aircraft).where(eq(aircraft.uuid, uuid)).get()?.id
}

/** The reverse of getAircraftIdByUuid — sync-engine.ts's push side needs an aircraft's
 *  uuid (not its local id, meaningless remotely) to serialize a flight's aircraftId.
 *
 * @param db The database.
 * @param id The local id.
 * @returns The sync uuid, null for a row without one, or undefined when missing.
 */
export function getAircraftUuidById(db: WingLogDb, id: number): string | null | undefined {
  return db.select({ uuid: aircraft.uuid }).from(aircraft).where(eq(aircraft.id, id)).get()?.uuid
}

// uuid/updatedAt (winglog-backend/docs/plans/cloud-sync.md) are set here rather than
// left to a DB default — see schema.ts's aircraft.uuid comment for why a DB-level default
// can't safely generate a distinct value per row for ALTER-TABLE-added columns; the same
// reasoning is why every write path sets both explicitly rather than relying on SQLite.
/**
 * Adds an aircraft to the fleet.
 *
 * @param db The database.
 * @param input The aircraft, already validated.
 * @returns The new aircraft.
 */
export function createAircraft(db: WingLogDb, input: NewAircraft): Aircraft {
  const [row] = db
    .insert(aircraft)
    .values({ ...input, uuid: randomUUID(), updatedAt: new Date().toISOString() })
    .returning()
    .all()
  return toAircraft(row)
}

/**
 * Edits an aircraft.
 *
 * @param db The database.
 * @param input The aircraft's id and its new values, already validated.
 * @returns The updated aircraft, or undefined when it doesn't exist.
 */
export function updateAircraft(db: WingLogDb, input: AircraftUpdate): Aircraft | undefined {
  const { id, ...values } = input
  const [row] = db
    .update(aircraft)
    .set({ ...values, updatedAt: new Date().toISOString() })
    .where(eq(aircraft.id, id))
    .returning()
    .all()
  return row ? toAircraft(row) : undefined
}

/**
 * Soft-delete (winglog-backend/docs/plans/cloud-sync-v2.md #3a) — a tombstone, not a
 * hard DELETE, so the deletion itself propagates through cloud sync instead of the row
 * just vanishing locally and getting resurrected by the next pull. Refuses to delete while
 * any non-deleted flight still references this aircraft — previously an incidental
 * consequence of the FK constraint a hard DELETE ran into, now checked explicitly since a
 * tombstoned row no longer trips that constraint at all.
 *
 * @param db The database.
 * @param id The aircraft.
 * @throws When a flight that isn't deleted still uses it.
 */
export function deleteAircraft(db: WingLogDb, id: number): void {
  const hasActiveFlights = db
    .select({ id: flight.id })
    .from(flight)
    .where(and(eq(flight.aircraftId, id), isNull(flight.deletedAt)))
    .get()
  if (hasActiveFlights) {
    throw new Error(t('errors.aircraftHasFlights'))
  }
  db.update(aircraft)
    .set({ deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    .where(eq(aircraft.id, id))
    .run()
}

export interface ReplaceAircraftInput {
  /** The aircraft being retired — every flight currently on it moves to replacementId. */
  retiredId: number
  /** The aircraft that takes over retiredId's flight history. */
  replacementId: number
}

/**
 * A livery/registration change on an airframe still being flown (winglog-backend's
 * docs/plans/aircraft-replacement.md) — reassigns every flight from `retiredId` onto
 * `replacementId` and marks `retiredId` retired, rather than deleting it, so Fleet can
 * still show "G-XXXX, retired, replaced by G-YYYY". A genuine retirement (an airframe
 * stops flying, an unrelated new one is added) needs none of this — just stop selecting
 * the old aircraft; that already works with what exists today.
 *
 * Both writes happen in one transaction — a partial merge (flights moved but the retired
 * flag never set, or vice versa) would be a worse state than either action alone.
 *
 * @param db The database.
 * @param input The aircraft to retire, and the one taking over its flights.
 * @returns The retired aircraft.
 * @throws When the two are the same, either is missing or deleted, or the first was already replaced.
 */
export function replaceAircraft(db: WingLogDb, input: ReplaceAircraftInput): Aircraft {
  const { retiredId, replacementId } = input
  if (retiredId === replacementId) throw new Error(t('errors.aircraftCannotReplaceSelf'))

  const retired = db
    .select()
    .from(aircraft)
    .where(and(eq(aircraft.id, retiredId), isNull(aircraft.deletedAt)))
    .get()
  if (!retired) throw new Error(`Aircraft ${retiredId} not found`)
  if (retired.replacedByAircraftId !== null) {
    throw new Error(t('errors.aircraftAlreadyReplaced', { registration: retired.registration }))
  }

  const replacement = db
    .select()
    .from(aircraft)
    .where(and(eq(aircraft.id, replacementId), isNull(aircraft.deletedAt)))
    .get()
  if (!replacement) throw new Error(`Aircraft ${replacementId} not found`)

  // Same uuid/updatedAt discipline as every other write path here (see the uuid comment
  // above) — uuid never changes after creation, but updatedAt must be bumped on every row
  // this touches so cloud sync picks up both the reassigned flights and the retired flag.
  const now = new Date().toISOString()
  db.transaction((tx) => {
    tx.update(flight)
      .set({ aircraftId: replacementId, updatedAt: now })
      .where(eq(flight.aircraftId, retiredId))
      .run()
    tx.update(aircraft)
      .set({ replacedByAircraftId: replacementId, updatedAt: now })
      .where(eq(aircraft.id, retiredId))
      .run()
  })

  const row = db.select().from(aircraft).where(eq(aircraft.id, retiredId)).get()
  if (!row) throw new Error(`Aircraft ${retiredId} not found after replace`)
  return toAircraft(row)
}

/** Plain Retire (docs/plans/fleet-retire.md): the aircraft keeps its own flights and simply
 *  stops being selectable. Bumps updatedAt so cloud sync carries it. `currentIcao` is left
 *  as-is. Rejects a missing, soft-deleted or already-retired (retired *or* replaced) one.
 *
 * @param db The database.
 * @param id The aircraft.
 * @returns The retired aircraft.
 * @throws When it's missing, deleted, or already retired or replaced.
 */
export function retireAircraft(db: WingLogDb, id: number): Aircraft {
  const row = db
    .select()
    .from(aircraft)
    .where(and(eq(aircraft.id, id), isNull(aircraft.deletedAt)))
    .get()
  if (!row) throw new Error(`Aircraft ${id} not found`)
  if (row.replacedByAircraftId !== null || row.retiredAt !== null) {
    throw new Error(t('errors.aircraftAlreadyRetired', { registration: row.registration }))
  }
  const now = new Date().toISOString()
  db.update(aircraft).set({ retiredAt: now, updatedAt: now }).where(eq(aircraft.id, id)).run()
  return toAircraft({ ...row, retiredAt: now, updatedAt: now })
}

/** Reverses retireAircraft. A *replaced* aircraft can't come back this way — its flights
 *  were moved to the replacement, so reactivating it would resurrect an empty duplicate.
 *
 * @param db The database.
 * @param id The aircraft.
 * @returns The aircraft, back in service.
 * @throws When it's missing, deleted, replaced, or not retired.
 */
export function unretireAircraft(db: WingLogDb, id: number): Aircraft {
  const row = db
    .select()
    .from(aircraft)
    .where(and(eq(aircraft.id, id), isNull(aircraft.deletedAt)))
    .get()
  if (!row) throw new Error(`Aircraft ${id} not found`)
  if (row.replacedByAircraftId !== null) {
    throw new Error(t('errors.aircraftReplacedCannotUnretire', { registration: row.registration }))
  }
  if (row.retiredAt === null)
    throw new Error(t('errors.aircraftNotRetired', { registration: row.registration }))
  const now = new Date().toISOString()
  db.update(aircraft).set({ retiredAt: null, updatedAt: now }).where(eq(aircraft.id, id)).run()
  return toAircraft({ ...row, retiredAt: null, updatedAt: now })
}

/** Rows with uuid/updatedAt set (every row written by this app version — see the
 *  uuid comment above) whose updatedAt is after `since`, oldest first — sync-engine.ts's
 *  push side. `since: null` means "never synced", i.e. every row.
 *
 * @param db The database.
 * @param since The sync cursor, or null for every row.
 * @returns The rows, oldest change first.
 */
export function listAircraftForSync(db: WingLogDb, since: string | null): (typeof aircraft.$inferSelect)[] {
  return rowsChangedSince(db.select().from(aircraft).all(), since)
}

/** Insert-or-update keyed by uuid, not local id — sync-engine.ts's pull side. There's no
 *  DB-level unique constraint on uuid (schema.ts's comment on why), so this is a plain
 *  select-then-insert-or-update rather than a single onConflictDoUpdate. A registration
 *  collision with a different local uuid (the same tail entered independently on two
 *  machines before they ever synced) surfaces as a thrown unique-constraint error, which
 *  sync-engine.ts catches per row rather than letting it abort the whole table.
 *
 *  Last-write-wins against a *local* edit, not just the server's own copy: if this device
 *  has its own not-yet-pushed edit to the same uuid and that edit's updatedAt is already
 *  >= the incoming (pulled) row's, the incoming row is discarded and the existing local
 *  row is left untouched — mirroring winglog-backend's UserStore.push exactly. Without
 *  this check, a pull unconditionally overwrote any local row sharing its uuid regardless
 *  of timestamp, so whichever device happened to run "Sync now" *second* always lost its
 *  own edit even when that edit was the chronologically newer one — the opposite of
 *  last-write-wins, and silently so (no push ever happens for a row that already looks
 *  identical to what the pull just wrote). Returns whether the incoming row was actually
 *  applied, so sync-engine.ts can report/log the other outcome instead of counting it as
 *  a normal pull.
 *
 * @param db The database.
 * @param input The pulled row.
 * @returns False when the local row is as new or newer, so nothing changed.
 */
export function upsertAircraftByUuid(
  db: WingLogDb,
  input: Omit<typeof aircraft.$inferInsert, 'id'> & { uuid: string }
): boolean {
  const existing = db.select().from(aircraft).where(eq(aircraft.uuid, input.uuid)).get()
  if (!shouldApplyPulledRow(existing, input.updatedAt)) return false
  if (existing) db.update(aircraft).set(input).where(eq(aircraft.uuid, input.uuid)).run()
  else db.insert(aircraft).values(input).run()
  return true
}
