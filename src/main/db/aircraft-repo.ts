import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { Aircraft, AircraftUpdate, NewAircraft } from '@shared/ipc'
import { aircraft, flight } from './schema'
import type { FlightdeckDb } from './client'

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
    currentIcao: row.currentIcao,
    createdAt: row.createdAt,
    replacedByAircraftId: row.replacedByAircraftId
  }
}

export function listAircraft(db: FlightdeckDb): Aircraft[] {
  return db.select().from(aircraft).all().map(toAircraft)
}

export function getAircraftByRegistration(db: FlightdeckDb, registration: string): Aircraft | undefined {
  const row = db.select().from(aircraft).where(eq(aircraft.registration, registration)).get()
  return row ? toAircraft(row) : undefined
}

export function getAircraftById(db: FlightdeckDb, id: number): Aircraft | undefined {
  const row = db.select().from(aircraft).where(eq(aircraft.id, id)).get()
  return row ? toAircraft(row) : undefined
}

/** See flight-repo.ts's getFlightIdByUuid for the shape/reasoning this mirrors. */
export function getAircraftIdByUuid(db: FlightdeckDb, uuid: string): number | undefined {
  return db.select({ id: aircraft.id }).from(aircraft).where(eq(aircraft.uuid, uuid)).get()?.id
}

/** The reverse of getAircraftIdByUuid — sync-engine.ts's push side needs an aircraft's
 *  uuid (not its local id, meaningless remotely) to serialize a flight's aircraftId. */
export function getAircraftUuidById(db: FlightdeckDb, id: number): string | null | undefined {
  return db.select({ uuid: aircraft.uuid }).from(aircraft).where(eq(aircraft.id, id)).get()?.uuid
}

// uuid/updatedAt (flightdeck-backend/docs/plans/cloud-sync.md) are set here rather than
// left to a DB default — see schema.ts's aircraft.uuid comment for why a DB-level default
// can't safely generate a distinct value per row for ALTER-TABLE-added columns; the same
// reasoning is why every write path sets both explicitly rather than relying on SQLite.
export function createAircraft(db: FlightdeckDb, input: NewAircraft): Aircraft {
  const [row] = db
    .insert(aircraft)
    .values({ ...input, uuid: randomUUID(), updatedAt: new Date().toISOString() })
    .returning()
    .all()
  return toAircraft(row)
}

export function updateAircraft(db: FlightdeckDb, input: AircraftUpdate): Aircraft | undefined {
  const { id, ...values } = input
  const [row] = db
    .update(aircraft)
    .set({ ...values, updatedAt: new Date().toISOString() })
    .where(eq(aircraft.id, id))
    .returning()
    .all()
  return row ? toAircraft(row) : undefined
}

export function deleteAircraft(db: FlightdeckDb, id: number): void {
  db.delete(aircraft).where(eq(aircraft.id, id)).run()
}

export interface ReplaceAircraftInput {
  /** The aircraft being retired — every flight currently on it moves to replacementId. */
  retiredId: number
  /** The aircraft that takes over retiredId's flight history. */
  replacementId: number
}

/**
 * A livery/registration change on an airframe still being flown (flightdeck-backend's
 * docs/plans/aircraft-replacement.md) — reassigns every flight from `retiredId` onto
 * `replacementId` and marks `retiredId` retired, rather than deleting it, so Fleet can
 * still show "G-XXXX, retired, replaced by G-YYYY". A genuine retirement (an airframe
 * stops flying, an unrelated new one is added) needs none of this — just stop selecting
 * the old aircraft; that already works with what exists today.
 *
 * Both writes happen in one transaction — a partial merge (flights moved but the retired
 * flag never set, or vice versa) would be a worse state than either action alone.
 */
export function replaceAircraft(db: FlightdeckDb, input: ReplaceAircraftInput): Aircraft {
  const { retiredId, replacementId } = input
  if (retiredId === replacementId) throw new Error('An aircraft cannot replace itself')

  const retired = db.select().from(aircraft).where(eq(aircraft.id, retiredId)).get()
  if (!retired) throw new Error(`Aircraft ${retiredId} not found`)
  if (retired.replacedByAircraftId !== null) {
    throw new Error(`${retired.registration} has already been replaced`)
  }

  const replacement = db.select().from(aircraft).where(eq(aircraft.id, replacementId)).get()
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

/** Rows with uuid/updatedAt set (every row written by this app version — see the
 *  uuid comment above) whose updatedAt is after `since`, oldest first — sync-engine.ts's
 *  push side. `since: null` means "never synced", i.e. every row. */
export function listAircraftForSync(db: FlightdeckDb, since: string | null): (typeof aircraft.$inferSelect)[] {
  const rows = db.select().from(aircraft).all()
  return rows
    .filter((row) => row.uuid !== null && row.updatedAt !== null && (since === null || row.updatedAt > since))
    .sort((a, b) => (a.updatedAt as string).localeCompare(b.updatedAt as string))
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
 *  row is left untouched — mirroring flightdeck-backend's UserStore.push exactly. Without
 *  this check, a pull unconditionally overwrote any local row sharing its uuid regardless
 *  of timestamp, so whichever device happened to run "Sync now" *second* always lost its
 *  own edit even when that edit was the chronologically newer one — the opposite of
 *  last-write-wins, and silently so (no push ever happens for a row that already looks
 *  identical to what the pull just wrote). Returns whether the incoming row was actually
 *  applied, so sync-engine.ts can report/log the other outcome instead of counting it as
 *  a normal pull. */
export function upsertAircraftByUuid(
  db: FlightdeckDb,
  input: Omit<typeof aircraft.$inferInsert, 'id'> & { uuid: string }
): boolean {
  const existing = db.select().from(aircraft).where(eq(aircraft.uuid, input.uuid)).get()
  if (existing) {
    if (existing.updatedAt !== null && typeof input.updatedAt === 'string' && existing.updatedAt >= input.updatedAt) {
      return false
    }
    db.update(aircraft).set(input).where(eq(aircraft.uuid, input.uuid)).run()
  } else {
    db.insert(aircraft).values(input).run()
  }
  return true
}
