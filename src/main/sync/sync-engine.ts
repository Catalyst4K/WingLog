/**
 * What a row means on the wire, for the four synced tables (aircraft, flight, landing, flight invoice): turning a local row into a sync row
 * (serializeChange) and applying one that came from a peer (applyPulledRow: last write wins, with aliases for a row another device holds under
 * a different uuid). When rows move, and in which order, is cursor-sync.ts: the cloud and the LAN link both use it, each talking to its peer
 * through the PagedSyncClient interface, so it is unit-testable against a mock.
 *
 * Each table's local rows are stored with a real integer id/FK for everything else in the
 * app to join on, but synced as an opaque {uuid, updatedAt, data} blob — the parent-table
 * reference inside `data` is the parent's *uuid*, translated to/from the local integer id
 * at the sync boundary only (aircraftUuid on a flight, flightUuid on a landing/invoice).
 */
import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { eq } from 'drizzle-orm'
import {
  getAircraftIdByUuid,
  getAircraftUuidByRegistration,
  getAircraftUuidById,
  linkReplacedAircraftByUuid,
  upsertAircraftByUuid
} from '../db/aircraft-repo'
import type { WingLogDb } from '../db/client'
import { hasInvoiceUnderOtherUuid, upsertFlightInvoiceByUuid } from '../db/flight-invoice-repo'
import { getAircraftRegistrationByUuid, mergeEmptyAircraft } from '../db/aircraft-merge-repo'
import { findLiveFlightByContent } from '../db/flight-match-repo'
import { getFlightIdByUuid, getFlightUuidById, upsertFlightByUuid } from '../db/flight-repo'
import { hasLandingUnderOtherUuid, upsertLandingByUuid } from '../db/landing-repo'
import { markOrigin } from '../db/sync-change-repo'
import { checkedPeerTime } from '../db/sync-rows'
import { getSetting, setSetting } from '../db/settings-repo'
import type { SyncRow, SyncTable } from '../backend/sync-client'
import { aircraft, flight, flightInvoice, gsxRoutine, landing } from '../db/schema'
import { getGsxRoutineByUuid, upsertGsxRoutineByUuid } from '../db/gsx-routine-repo'
import { BUILT_IN_ROUTINES, checkRoutine } from '@shared/gsx-routines'
import { ofpFromWire, ofpToWire } from './ofp-wire'
import { timeSlicer } from './time-slice'
import { validateSyncFields } from './sync-row-validation'

export interface SyncSession {
  email: string
  token: string
}

export interface SyncTableResult {
  pulled: number
  pushed: number
  /** uuids on the losing side of a last-write-wins comparison — logged to
   *  sync-conflicts.log, not silently dropped. Covers both directions: a push the server
   *  already had a newer updatedAt for, *and* a pulled row this device didn't apply
   *  because its own not-yet-pushed local edit was already the same age or newer. */
  rejected: string[]
  /** uuids that couldn't be applied at all — an unresolved parent reference, or malformed
   *  data. Also logged; distinct from `rejected` (a real conflict) since these are data
   *  problems, not a legitimate two-sided edit. */
  skipped: string[]
}

export interface SyncResult {
  syncedAt: string
  tables: Record<SyncTable, SyncTableResult>
}

function conflictLogPath(dbPath: string): string {
  return join(dirname(dbPath), 'sync-conflicts.log')
}

/**
 * Appends one line to sync-conflicts.log, next to the database: a row that lost, was refused, or could not be applied or sent.
 *
 * @param dbPath The database file's path.
 * @param event What happened, as fields.
 */
export function logSyncEvent(dbPath: string, event: Record<string, unknown>): void {
  appendFileSync(
    conflictLogPath(dbPath),
    JSON.stringify({ loggedAt: new Date().toISOString(), ...event }) + '\n'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Cheap defensive parse (CLAUDE.md: "external data is data, never code, parse
 * defensively") — this is server-relayed data this same app wrote, not a hostile third
 * party, but it did cross a network boundary, so a malformed row degrades to "skipped"
 * rather than throwing and aborting the whole table's sync.
 *
 * @param json A pulled row's data.
 * @returns The row, or null if it isn't a JSON object.
 */
function parseRowData(json: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(json)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Shallow copy with the given keys removed — used instead of destructure-and-discard
 * (`const { x: _x, ...rest } = obj`) so the deliberately-unused binding doesn't need a
 * lint exemption.
 *
 * @param obj The object.
 * @param keys The keys to leave out.
 * @returns The copy.
 */
function omit<T extends Record<string, unknown>>(obj: T, keys: string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...obj }
  for (const key of keys) delete copy[key]
  return copy
}

/** Outcome of applying one pulled row locally. `applied: false` means the row was a
 *  legitimate last-write-wins loser against this device's own not-yet-pushed local edit
 *  (see upsertAircraftByUuid's comment) — distinct from `ok: false`, which means the row
 *  itself couldn't be applied at all (malformed data, unresolved parent reference). `uuid` is the local uuid the row was written under: the one its alias points to when it
 *  was merged into a row this device already had, which is the row a sync mark has to go on. */
export type ApplyResult = { ok: true; applied: boolean; uuid: string } | { ok: false; error: string }

// --- aircraft ---------------------------------------------------------------------------

/**
 * An aircraft as a sync row. `replacedByAircraftId` is a local id, meaningless on another device, so
 * it travels as the replacing aircraft's uuid like every other parent reference.
 *
 * @param db The database.
 * @param row The aircraft row.
 * @returns The row to push.
 */
function serializeAircraft(db: WingLogDb, row: typeof aircraft.$inferSelect): SyncRow {
  const replacedByAircraftUuid =
    row.replacedByAircraftId == null ? null : (getAircraftUuidById(db, row.replacedByAircraftId) ?? null)
  return {
    uuid: row.uuid as string,
    updatedAt: row.updatedAt as string,
    data: JSON.stringify({
      ...omit(row, ['id', 'uuid', 'updatedAt', 'replacedByAircraftId']),
      replacedByAircraftUuid
    })
  }
}

/**
 * The local uuid of an aircraft that another device created under a different uuid but the same
 * registration. Registrations are unique, so two devices that each add the same aircraft offline would
 * otherwise never merge: the second one to arrive could not be applied.
 *
 * @param db The database.
 * @param uuid The uuid on the incoming row, or on a flight's reference to it.
 * @returns The local uuid it stands for, or the same uuid when it has no alias.
 */
function resolveAircraftUuid(db: WingLogDb, uuid: string): string {
  return getSetting(db, `aircraftAlias:${uuid}`) ?? uuid
}

function applyAircraft(db: WingLogDb, row: SyncRow): ApplyResult {
  const data = parseRowData(row.data)
  if (!data || typeof data.registration !== 'string' || typeof data.icaoType !== 'string') {
    return { ok: false, error: 'malformed aircraft data' }
  }
  const checked = validateSyncFields(aircraft, data, ['replacedByAircraftId'])
  if (!checked.ok) return checked
  let uuid = resolveAircraftUuid(db, row.uuid)
  if (getAircraftIdByUuid(db, uuid) === undefined) {
    const sameRegistration = getAircraftUuidByRegistration(db, data.registration)
    if (sameRegistration !== undefined) {
      setSetting(db, `aircraftAlias:${row.uuid}`, sameRegistration)
      uuid = sameRegistration
    }
  }
  // A row reached through an alias is another device's name for an aircraft this device already has. Its other fields can win by last write,
  // but not the registration: the other device's name for it (an old registration) must not rename the aircraft back.
  const registration =
    uuid === row.uuid ? data.registration : (getAircraftRegistrationByUuid(db, uuid) ?? data.registration)
  try {
    const applied = upsertAircraftByUuid(db, {
      ...checked.fields,
      registration,
      uuid,
      updatedAt: row.updatedAt
    } as Parameters<typeof upsertAircraftByUuid>[1])
    return { ok: true, applied, uuid }
  } catch (err) {
    /* v8 ignore start -- better-sqlite3 always throws real Error instances; the String(err)
     * arm exists only for TypeScript's sake (a catch variable is typed `unknown`), not a
     * case real testing can trigger. */
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
    /* v8 ignore stop */
  }
}

/**
 * Points each pulled aircraft at the one that replaced it. Done after the whole pull because the
 * replacing aircraft may come later in the same batch; one that never arrives leaves the link empty.
 *
 * A row that lost to a newer or equal one here still counts, but only where this device has no link yet. A replacement is never undone, and
 * a device that set up its own copy of the fleet (a Mac with its own import) holds a newer row for an aircraft that the other device had
 * already replaced: that row wins, carries no link, and without this the replaced aircraft stays in the normal list with no flights.
 *
 * @param db The database.
 * @param rows The aircraft rows pulled, and whether each was applied (won) or lost to a row already here.
 */
export function linkPulledReplacements(db: WingLogDb, rows: { row: SyncRow; applied: boolean }[]): void {
  for (const { row, applied } of rows) {
    const replacedBy = parseRowData(row.data)?.replacedByAircraftUuid
    if (typeof replacedBy === 'string') {
      linkReplacedAircraftByUuid(
        db,
        resolveAircraftUuid(db, row.uuid),
        resolveAircraftUuid(db, replacedBy),
        !applied
      )
    }
  }
}

// --- flight -----------------------------------------------------------------------------

/**
 * The local uuid of a flight that another device holds under a different uuid: the same route and the same out-time. Landings and
 * receipts refer to a flight by uuid, so they follow the alias too.
 *
 * @param db The database.
 * @param uuid The uuid on the incoming flight, or on a landing's or receipt's reference to it.
 * @returns The local uuid it stands for, or the same uuid when it has no alias.
 */
function resolveFlightUuid(db: WingLogDb, uuid: string): string {
  return getSetting(db, `flightAlias:${uuid}`) ?? uuid
}

function serializeFlight(db: WingLogDb, row: typeof flight.$inferSelect): SyncRow | null {
  // A free flight tracked with no fleet aircraft (free-flight-tracking.md's "don't add to fleet" option) has no aircraftId. It syncs with a
  // null aircraftUuid: the flight's own simRegistration and simIcaoType already say which aircraft it was.
  const aircraftUuid = row.aircraftId == null ? null : getAircraftUuidById(db, row.aircraftId)
  if (row.aircraftId != null && !aircraftUuid) return null // parent aircraft has no uuid yet — shouldn't happen, see schema.ts
  return {
    uuid: row.uuid as string,
    updatedAt: row.updatedAt as string,
    data: JSON.stringify({
      ...omit(row, ['id', 'uuid', 'updatedAt', 'aircraftId', 'ofpJson']),
      aircraftUuid,
      ofpJsonZ: ofpToWire(row.ofpJson)
    })
  }
}

/**
 * Looks for the same real flight under another uuid: this device was set up from the same history. If there is one, it is remembered as an
 * alias, so the pulled row is applied onto it, and it keeps its own aircraft: the incoming aircraft may be the same one under an old
 * registration, which this device never matched. One flight cannot be on two aircraft, so an incoming aircraft that is only an empty copy of
 * the one the flight is really on is folded into it, and the fleet doesn't keep an empty extra. A real aircraft with flights is left alone.
 *
 * @param db The database.
 * @param incomingUuid The pulled flight's uuid.
 * @param data The pulled flight's fields.
 * @param incomingAircraftId The local aircraft the pulled flight names, when it names one.
 * @returns The local flight's uuid and aircraft to apply the row onto, or undefined when no local flight is the same flight.
 */
function mergeIntoMatchingFlight(
  db: WingLogDb,
  incomingUuid: string,
  data: Record<string, unknown>,
  incomingAircraftId: number | null
): { uuid: string; aircraftId: number | null } | undefined {
  // Only a live copy is the same flight as a live one here. A deleted copy (a duplicate someone removed) must stay its own deleted row:
  // merged into the live original, its deletion would delete the original, and then sync it back to every device.
  if ((data.deletedAt ?? null) !== null) return undefined
  const { depIcao, arrIcao, actualOutUtc, aircraftUuid } = data
  if (typeof depIcao !== 'string' || typeof arrIcao !== 'string' || typeof actualOutUtc !== 'string')
    return undefined
  const same = findLiveFlightByContent(db, depIcao, arrIcao, actualOutUtc)
  if (!same) return undefined
  setSetting(db, `flightAlias:${incomingUuid}`, same.uuid)
  if (incomingAircraftId !== null && same.aircraftId !== null && typeof aircraftUuid === 'string') {
    mergeEmptyAircraft(db, incomingAircraftId, same.aircraftId, aircraftUuid)
  }
  return same
}

/**
 * Applies one pulled flight row to the local database, by uuid. The aircraft it refers to must already
 * exist.
 *
 * @param db The database.
 * @param row The pulled row.
 * @returns Whether it applied, or the reason it didn't.
 */
function applyFlight(db: WingLogDb, row: SyncRow): ApplyResult {
  const data = parseRowData(row.data)
  if (
    !data ||
    !(data.aircraftUuid === null || typeof data.aircraftUuid === 'string') ||
    typeof data.depIcao !== 'string' ||
    typeof data.arrIcao !== 'string'
  ) {
    return { ok: false, error: 'malformed flight data' }
  }
  // A null aircraftUuid is a free flight with no fleet aircraft.
  let aircraftId: number | null = null
  let incomingAircraftId: number | null = null
  if (data.aircraftUuid !== null) {
    const found = getAircraftIdByUuid(db, resolveAircraftUuid(db, data.aircraftUuid))
    if (found === undefined) return { ok: false, error: `unknown aircraft ${data.aircraftUuid}` }
    aircraftId = found
    incomingAircraftId = found
  }
  const checked = validateSyncFields(flight, data, ['aircraftId'])
  if (!checked.ok) return checked
  const ofp = ofpFromWire(data)
  if (!ofp.ok) return ofp
  let uuid = resolveFlightUuid(db, row.uuid)
  if (getFlightIdByUuid(db, uuid) === undefined) {
    const same = mergeIntoMatchingFlight(db, row.uuid, data, incomingAircraftId)
    if (same) {
      uuid = same.uuid
      aircraftId = same.aircraftId
    }
  }
  try {
    const applied = upsertFlightByUuid(db, {
      ...checked.fields,
      ...ofp.fields,
      aircraftId,
      uuid,
      updatedAt: row.updatedAt
    } as Parameters<typeof upsertFlightByUuid>[1])
    return { ok: true, applied, uuid }
  } catch (err) {
    /* v8 ignore start -- unlike aircraft (unique registration) or landing/flightInvoice
     * (required fields the malformed-data check above doesn't cover), the flight table has
     * no constraint a row already passing that check can still violate at insert. */
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
    /* v8 ignore stop */
  }
}

// --- landing ----------------------------------------------------------------------------

function serializeLanding(db: WingLogDb, row: typeof landing.$inferSelect): SyncRow | null {
  const flightUuid = getFlightUuidById(db, row.flightId)
  if (!flightUuid) return null // parent flight not yet pulled/created here — retried next sync
  return {
    uuid: row.uuid as string,
    updatedAt: row.updatedAt as string,
    data: JSON.stringify({ ...omit(row, ['id', 'uuid', 'updatedAt', 'flightId']), flightUuid })
  }
}

function applyLanding(db: WingLogDb, row: SyncRow): ApplyResult {
  const data = parseRowData(row.data)
  if (!data || typeof data.flightUuid !== 'string') return { ok: false, error: 'malformed landing data' }
  const flightId = getFlightIdByUuid(db, resolveFlightUuid(db, data.flightUuid))
  if (flightId === undefined) return { ok: false, error: `unknown flight ${data.flightUuid}` }
  // The flight is one that both devices already had: a landing it already has under another uuid is the same touchdown.
  if (hasLandingUnderOtherUuid(db, flightId, typeof data.seq === 'number' ? data.seq : 1, row.uuid)) {
    return { ok: true, applied: false, uuid: row.uuid }
  }
  const checked = validateSyncFields(landing, data, ['flightId'])
  if (!checked.ok) return checked
  try {
    const applied = upsertLandingByUuid(db, {
      ...checked.fields,
      flightId,
      uuid: row.uuid,
      updatedAt: row.updatedAt
    } as Parameters<typeof upsertLandingByUuid>[1])
    return { ok: true, applied, uuid: row.uuid }
  } catch (err) {
    /* v8 ignore start -- see applyAircraft's identical catch for why the String(err) arm is
     * excluded. */
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
    /* v8 ignore stop */
  }
}

// --- flightInvoice ------------------------------------------------------------------------

function serializeFlightInvoice(db: WingLogDb, row: typeof flightInvoice.$inferSelect): SyncRow | null {
  const flightUuid = getFlightUuidById(db, row.flightId)
  if (!flightUuid) return null
  return {
    uuid: row.uuid as string,
    updatedAt: row.updatedAt as string,
    data: JSON.stringify({ ...omit(row, ['id', 'uuid', 'updatedAt', 'flightId']), flightUuid })
  }
}

/**
 * Applies one pulled receipt row to the local database, by uuid. The flight it refers to must already
 * exist.
 *
 * @param db The database.
 * @param row The pulled row.
 * @returns Whether it applied, or the reason it didn't.
 */
function applyFlightInvoice(db: WingLogDb, row: SyncRow): ApplyResult {
  const data = parseRowData(row.data)
  if (!data || typeof data.flightUuid !== 'string' || typeof data.receiptId !== 'string') {
    return { ok: false, error: 'malformed flightInvoice data' }
  }
  const flightId = getFlightIdByUuid(db, resolveFlightUuid(db, data.flightUuid))
  if (flightId === undefined) return { ok: false, error: `unknown flight ${data.flightUuid}` }
  if (hasInvoiceUnderOtherUuid(db, flightId, data.receiptId, row.uuid))
    return { ok: true, applied: false, uuid: row.uuid }
  const checked = validateSyncFields(flightInvoice, data, ['flightId'])
  if (!checked.ok) return checked
  try {
    const applied = upsertFlightInvoiceByUuid(db, {
      ...checked.fields,
      flightId,
      uuid: row.uuid,
      updatedAt: row.updatedAt
    } as Parameters<typeof upsertFlightInvoiceByUuid>[1])
    return { ok: true, applied, uuid: row.uuid }
  } catch (err) {
    /* v8 ignore start -- see applyAircraft's identical catch for why the String(err) arm is
     * excluded. */
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
    /* v8 ignore stop */
  }
}

// --- gsxRoutine ---------------------------------------------------------------------------

function serializeGsxRoutine(row: typeof gsxRoutine.$inferSelect): SyncRow {
  return {
    uuid: row.uuid,
    updatedAt: row.updatedAt,
    data: JSON.stringify({ kind: row.kind, data: row.data, deletedAt: row.deletedAt })
  }
}

/**
 * Applies one pulled GSX routine row. External data, so it is checked as a routine is checked when the pilot saves one: a row that is not
 * a valid routine, or whose key is not the routine's own id, is refused and never run.
 *
 * @param db The database.
 * @param row The pulled row.
 * @returns Whether it applied, or the reason it didn't.
 */
function applyGsxRoutine(db: WingLogDb, row: SyncRow): ApplyResult {
  const data = parseRowData(row.data)
  if (!data || (data.kind !== 'routine' && data.kind !== 'hidden') || typeof data.data !== 'string') {
    return { ok: false, error: 'malformed gsxRoutine data' }
  }
  const deletedAt = data.deletedAt ?? null
  if (deletedAt !== null && (typeof deletedAt !== 'string' || deletedAt.length > 40)) {
    return { ok: false, error: 'malformed gsxRoutine deletedAt' }
  }
  let stored = '{}'
  if (data.kind === 'hidden') {
    if (!BUILT_IN_ROUTINES.some((routine) => `hidden-${routine.id}` === row.uuid)) {
      return { ok: false, error: 'a hidden routine that is not a built-in' }
    }
  } else if (deletedAt === null) {
    let parsed: unknown
    try {
      parsed = JSON.parse(data.data)
    } catch {
      return { ok: false, error: 'the routine is not valid JSON' }
    }
    const checked = checkRoutine(parsed)
    if (!checked.ok) return { ok: false, error: `not a valid routine: ${checked.reason}` }
    if (checked.routine.id !== row.uuid) return { ok: false, error: 'the routine id is not the row key' }
    stored = JSON.stringify(checked.routine)
  }
  const applied = upsertGsxRoutineByUuid(db, {
    uuid: row.uuid,
    kind: data.kind,
    data: stored,
    deletedAt,
    updatedAt: row.updatedAt
  })
  return { ok: true, applied, uuid: row.uuid }
}

// --- dispatch -----------------------------------------------------------------------------

/**
 * One local row as a sync row, looked up by its uuid: what a counted change is sent as.
 *
 * @param db The database.
 * @param table The table the row is in.
 * @param uuid The row's uuid.
 * @returns The row, or null when it is gone or cannot be sent yet (its parent has no uuid).
 */
export function serializeChange(db: WingLogDb, table: SyncTable, uuid: string): SyncRow | null {
  switch (table) {
    case 'aircraft': {
      const row = db.select().from(aircraft).where(eq(aircraft.uuid, uuid)).get()
      return row ? serializeAircraft(db, row) : null
    }
    case 'flight': {
      const row = db.select().from(flight).where(eq(flight.uuid, uuid)).get()
      return row ? serializeFlight(db, row) : null
    }
    case 'landing': {
      const row = db.select().from(landing).where(eq(landing.uuid, uuid)).get()
      return row ? serializeLanding(db, row) : null
    }
    case 'flightInvoice': {
      const row = db.select().from(flightInvoice).where(eq(flightInvoice.uuid, uuid)).get()
      return row ? serializeFlightInvoice(db, row) : null
    }
    case 'gsxRoutine': {
      const row = getGsxRoutineByUuid(db, uuid)
      return row ? serializeGsxRoutine(row) : null
    }
  }
}

/**
 * Applies one row that came from another device, by uuid, with last write wins. Its time is checked first (`checkedPeerTime`): a time that is not real, or is more than a day ahead, refuses the row, and a valid one is stored in `toISOString`'s form.
 *
 * @param db The database.
 * @param table The table the row is for.
 * @param pulled The row, as it came.
 * @returns Whether it applied, lost to a newer local row, or could not be applied.
 */
export function applyPulledRow(db: WingLogDb, table: SyncTable, pulled: SyncRow): ApplyResult {
  // Every row from outside goes through here (the cloud pull, a twin's pull, a twin's push), so this is the one place its time is checked.
  const updatedAt = checkedPeerTime(pulled.updatedAt, Date.now())
  if (updatedAt === null) {
    return {
      ok: false,
      error: `updatedAt is not a real time within a day of this computer's clock: ${JSON.stringify(pulled.updatedAt).slice(0, 80)}`
    }
  }
  const row = { ...pulled, updatedAt }
  switch (table) {
    case 'aircraft':
      return applyAircraft(db, row)
    case 'flight':
      return applyFlight(db, row)
    case 'landing':
      return applyLanding(db, row)
    case 'flightInvoice':
      return applyFlightInvoice(db, row)
    case 'gsxRoutine':
      return applyGsxRoutine(db, row)
  }
}

/** The backend's push limits (winglog-backend `routes/sync.ts`): rows per request, one row's data, and
 *  the request body. The body cap is kept under the backend's 25 MB to leave room for the envelope. */
export const MAX_PUSH_ROWS = 500
export const MAX_ROW_DATA_BYTES = 1_900_000
export const MAX_PUSH_BATCH_BYTES = 20 * 1024 * 1024

/**
 * Splits rows into pushes the backend will accept. A row whose data alone is over the backend's limit
 * would make it refuse the whole request, so it is set aside instead of sent.
 *
 * @param rows The rows to push.
 * @returns The batches, in order, and the uuids of rows too large to push.
 */
export function splitPushBatches(rows: SyncRow[]): { batches: SyncRow[][]; oversize: string[] } {
  const batches: SyncRow[][] = []
  const oversize: string[] = []
  let current: SyncRow[] = []
  let currentBytes = 0
  for (const row of rows) {
    const bytes = Buffer.byteLength(row.data) + Buffer.byteLength(row.uuid) + Buffer.byteLength(row.updatedAt)
    if (Buffer.byteLength(row.data) > MAX_ROW_DATA_BYTES) {
      oversize.push(row.uuid)
      continue
    }
    if (current.length >= MAX_PUSH_ROWS || currentBytes + bytes > MAX_PUSH_BATCH_BYTES) {
      batches.push(current)
      current = []
      currentBytes = 0
    }
    current.push(row)
    currentBytes += bytes
  }
  if (current.length > 0) batches.push(current)
  return { batches, oversize }
}

/**
 * The host's side of a twin's push: applies each row as a pull would, which is last write wins by `updatedAt`, with every row validated.
 *
 * @param db The database.
 * @param table The table the rows are for.
 * @param rows The rows the twin pushed.
 * @param dbPath The database file's path, which says where sync-conflicts.log goes.
 * @param origin Who the rows came from (a twin), recorded so they are not sent back to it.
 * @returns The uuids applied, and those not (a newer row here, or a row that could not be applied: both are logged).
 */
export async function applyPushedRows(
  db: WingLogDb,
  table: SyncTable,
  rows: SyncRow[],
  dbPath: string,
  origin?: string
): Promise<{ upserted: string[]; rejected: string[] }> {
  const upserted: string[] = []
  const rejected: string[] = []
  const pulled: { row: SyncRow; applied: boolean }[] = []
  // A push can be hundreds of rows: the window gets the thread back between rows.
  const slice = timeSlicer()
  for (const row of rows) {
    await slice()
    const outcome = applyPulledRow(db, table, row)
    if (outcome.ok) pulled.push({ row, applied: outcome.applied })
    if (outcome.ok && outcome.applied) {
      upserted.push(row.uuid)
      // Marked on the uuid the row was written under, so a row from this twin is not handed back to it, while one from another peer still goes on.
      if (origin !== undefined) markOrigin(db, table, outcome.uuid, origin)
      continue
    }
    rejected.push(row.uuid)
    logSyncEvent(dbPath, {
      direction: 'twin-push',
      table,
      uuid: row.uuid,
      reason: outcome.ok ? 'this PC already had a newer or equal updatedAt (last-write-wins)' : outcome.error
    })
  }
  if (table === 'aircraft') linkPulledReplacements(db, pulled)
  return { upserted, rejected }
}
