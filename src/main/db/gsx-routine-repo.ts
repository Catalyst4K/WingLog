/**
 * The pilot's GSX routines, one row each, synced like the logbook (winglog-backend's docs/plans/gsx-routines-sync.md). A row is a routine
 * the pilot made (or their version of a built-in), or a mark that a built-in was deleted. A deletion keeps the row with `deletedAt` set, so
 * it reaches the other computers.
 */
import { and, eq, isNull } from 'drizzle-orm'
import {
  BUILT_IN_ROUTINES,
  parseStoredRoutines,
  type GsxRoutine,
  type StoredRoutines
} from '@shared/gsx-routines'
import { gsxRoutine } from './schema'
import type { WingLogDb } from './client'
import { shouldApplyPulledRow } from './sync-rows'

/**
 * @param builtInId A built-in routine's id.
 * @returns The row key of its deleted mark: the same on every computer, so it is the same row everywhere.
 */
function hiddenKey(builtInId: string): string {
  return `hidden-${builtInId}`
}

/**
 * @param db The database.
 * @returns The pilot's own valid routines, in the order they were first made, and why anything was dropped. A row that is not a valid
 *   routine (it arrived from another computer and was edited by hand) is left out and reported, never run.
 */
export function listOwnRoutines(db: WingLogDb): StoredRoutines {
  const rows = db
    .select({ data: gsxRoutine.data })
    .from(gsxRoutine)
    .where(and(eq(gsxRoutine.kind, 'routine'), isNull(gsxRoutine.deletedAt)))
    .orderBy(gsxRoutine.id)
    .all()
  return parseStoredRoutines(`[${rows.map((row) => row.data).join(',')}]`)
}

/**
 * @param db The database.
 * @returns The ids of the built-in routines the pilot deleted.
 */
export function listHiddenBuiltIns(db: WingLogDb): string[] {
  const hidden = new Set(
    db
      .select({ uuid: gsxRoutine.uuid })
      .from(gsxRoutine)
      .where(and(eq(gsxRoutine.kind, 'hidden'), isNull(gsxRoutine.deletedAt)))
      .all()
      .map((row) => row.uuid)
  )
  return BUILT_IN_ROUTINES.map((routine) => routine.id).filter((id) => hidden.has(hiddenKey(id)))
}

/**
 * Writes a row, or updates it if there is one with the uuid.
 *
 * @param db The database.
 * @param uuid The row's key.
 * @param fields The row's other fields.
 */
function write(
  db: WingLogDb,
  uuid: string,
  fields: Pick<typeof gsxRoutine.$inferInsert, 'kind' | 'data' | 'deletedAt'>
): void {
  const updatedAt = new Date().toISOString()
  db.insert(gsxRoutine)
    .values({ uuid, ...fields, updatedAt })
    .onConflictDoUpdate({ target: gsxRoutine.uuid, set: { ...fields, updatedAt } })
    .run()
}

/**
 * Saves a routine the caller has checked (`checkRoutine`): a new one, or a new version of one with the same id. Saving a built-in's id
 * makes it the pilot's own version of that built-in.
 *
 * @param db The database.
 * @param routine The routine.
 */
export function saveOwnRoutine(db: WingLogDb, routine: GsxRoutine): void {
  write(db, routine.id, { kind: 'routine', data: JSON.stringify(routine), deletedAt: null })
}

/**
 * Deletes a routine: the pilot's own is marked deleted; a built-in is hidden (it stays in the app, out of the list), along with any version
 * of it the pilot made.
 *
 * @param db The database.
 * @param id The routine's id.
 */
export function deleteOwnRoutine(db: WingLogDb, id: string): void {
  const existing = db.select({ id: gsxRoutine.id }).from(gsxRoutine).where(eq(gsxRoutine.uuid, id)).get()
  if (existing) write(db, id, { kind: 'routine', data: '{}', deletedAt: new Date().toISOString() })
  if (BUILT_IN_ROUTINES.some((routine) => routine.id === id)) {
    write(db, hiddenKey(id), { kind: 'hidden', data: '{}', deletedAt: null })
  }
}

/**
 * @param db The database.
 * @param uuid A routine's row key.
 * @returns The row, or undefined.
 */
export function getGsxRoutineByUuid(db: WingLogDb, uuid: string): typeof gsxRoutine.$inferSelect | undefined {
  return db.select().from(gsxRoutine).where(eq(gsxRoutine.uuid, uuid)).get()
}

/**
 * Applies a routine row that came from another computer, last write wins.
 *
 * @param db The database.
 * @param input The row, already checked.
 * @returns False when the row here is as new or newer, so nothing changed.
 */
export function upsertGsxRoutineByUuid(
  db: WingLogDb,
  input: Omit<typeof gsxRoutine.$inferInsert, 'id'>
): boolean {
  const existing = getGsxRoutineByUuid(db, input.uuid)
  if (!shouldApplyPulledRow(existing, input.updatedAt)) return false
  if (existing) db.update(gsxRoutine).set(input).where(eq(gsxRoutine.uuid, input.uuid)).run()
  else db.insert(gsxRoutine).values(input).run()
  return true
}
