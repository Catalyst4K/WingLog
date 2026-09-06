import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { Aircraft, AircraftUpdate, NewAircraft } from '@shared/ipc'
import { aircraft } from './schema'
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
    createdAt: row.createdAt
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
 *  sync-engine.ts catches per row rather than letting it abort the whole table. */
export function upsertAircraftByUuid(
  db: FlightdeckDb,
  input: Omit<typeof aircraft.$inferInsert, 'id'> & { uuid: string }
): void {
  const existing = db.select().from(aircraft).where(eq(aircraft.uuid, input.uuid)).get()
  if (existing) {
    db.update(aircraft).set(input).where(eq(aircraft.uuid, input.uuid)).run()
  } else {
    db.insert(aircraft).values(input).run()
  }
}
