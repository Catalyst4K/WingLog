/**
 * Touchdowns in the database: recording each one a flight makes, and the lists the Logbook and Fleet
 * show, newest first. Deleting a flight soft-deletes its landings with it.
 */
import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import type { AircraftLandingRow, Landing, NewLanding } from '@shared/ipc'
import { aircraft, flight, landing } from './schema'
import type { WingLogDb } from './client'
import { rowsChangedSince, shouldApplyPulledRow } from './sync-rows'

/**
 * A database row as a Landing.
 *
 * @param row The `landing` row.
 * @returns The landing as the app sees it.
 */
function toLanding(row: typeof landing.$inferSelect): Landing {
  return {
    id: row.id,
    flightId: row.flightId,
    seq: row.seq,
    icao: row.icao,
    touchdownTsUtc: row.touchdownTsUtc,
    verticalSpeedMs: row.verticalSpeedMs,
    gForce: row.gForce,
    pitchDeg: row.pitchDeg,
    bankDeg: row.bankDeg,
    headingTrueDeg: row.headingTrueDeg,
    indicatedAirspeedMs: row.indicatedAirspeedMs,
    groundSpeedMs: row.groundSpeedMs,
    windSpeedMs: row.windSpeedMs,
    windDirectionDeg: row.windDirectionDeg,
    headwindMs: row.headwindMs,
    crosswindMs: row.crosswindMs,
    crabDeg: row.crabDeg,
    runwayIdent: row.runwayIdent,
    distanceFromThresholdM: row.distanceFromThresholdM,
    centrelineOffsetM: row.centrelineOffsetM,
    flapSetting: row.flapSetting,
    touchdownSource: row.touchdownSource
  }
}

// Lives in src/shared so the host-side landing capture can use it without importing the database.
export type { NewLanding } from '@shared/ipc'

/** The flight's most recent touchdown — the one Logbook's landing card defaults to
 *  (winglog-backend's docs/plans/multiple-landings.md). Kept alongside
 *  listLandingsByFlight below for callers that only ever cared about "the" landing.
 *
 * @param db The database.
 * @param flightId The flight.
 * @returns The last landing, or undefined.
 */
export function getLandingByFlight(db: WingLogDb, flightId: number): Landing | undefined {
  const row = db
    .select()
    .from(landing)
    .where(and(eq(landing.flightId, flightId), isNull(landing.deletedAt)))
    .orderBy(desc(landing.seq))
    .get()
  return row ? toLanding(row) : undefined
}

/** Every non-deleted landing, ordered by flight then seq — for building per-flight summaries
 *  in one query instead of one query per flight.
 *
 * @param db The database.
 * @returns The landings.
 */
export function listLiveLandings(db: WingLogDb): Landing[] {
  return db.select().from(landing).where(isNull(landing.deletedAt)).orderBy(asc(landing.flightId), asc(landing.seq)).all().map(toLanding)
}

/**
 * Every touchdown recorded for a flight, in the order they happened.
 *
 * @param db The database.
 * @param flightId The flight.
 * @returns Its landings, first touchdown first.
 */
export function listLandingsByFlight(db: WingLogDb, flightId: number): Landing[] {
  return db
    .select()
    .from(landing)
    .where(and(eq(landing.flightId, flightId), isNull(landing.deletedAt)))
    .orderBy(asc(landing.seq))
    .all()
    .map(toLanding)
}

/**
 * (flight_id, seq) is the unique target now, not flight_id alone — a flight can have many
 * touchdowns (winglog-backend's docs/plans/multiple-landings.md), but a re-capture of
 * the *same* touchdown (e.g. a replay) still replaces rather than duplicates. `set`
 * deliberately omits `uuid`: a re-capture of an existing landing keeps its original sync
 * identity rather than minting a new one, while a genuinely new row gets one from `values`
 * (winglog-backend/docs/plans/cloud-sync.md) — updatedAt bumps either way, so a
 * re-capture still re-syncs.
 *
 * @param db The database.
 * @param input The touchdown, with its flight and sequence number.
 * @returns The stored landing.
 */
export function createLanding(db: WingLogDb, input: NewLanding): Landing {
  const now = new Date().toISOString()
  const [row] = db
    .insert(landing)
    .values({ ...input, uuid: randomUUID(), updatedAt: now })
    .onConflictDoUpdate({ target: [landing.flightId, landing.seq], set: { ...input, updatedAt: now } })
    .returning()
    .all()
  return toLanding(row)
}

/** Fleet's per-aircraft landing history — one join, newest first. Aircraft with no
 *  landing records (the common case for a while) simply return an empty array.
 *
 * @param db The database.
 * @param aircraftId The fleet aircraft.
 * @returns Its landings, with each flight's number and airports.
 */
export function listLandingsByAircraft(db: WingLogDb, aircraftId: number): AircraftLandingRow[] {
  return db
    .select({
      landing: landing,
      flightNumber: flight.flightNumber,
      depIcao: flight.depIcao,
      arrIcao: flight.arrIcao
    })
    .from(landing)
    .innerJoin(flight, eq(landing.flightId, flight.id))
    .where(and(eq(flight.aircraftId, aircraftId), isNull(landing.deletedAt), isNull(flight.deletedAt)))
    .orderBy(desc(landing.touchdownTsUtc))
    .all()
    .map((row) => ({
      ...toLanding(row.landing),
      flightNumber: row.flightNumber,
      depIcao: row.depIcao,
      arrIcao: row.arrIcao
    }))
}

/** Every touchdown across every non-deleted flight, newest first — the Logbook Landings
 *  sub-tab (winglog-backend's docs/plans/multiple-landings.md Phase 2/3), spanning the
 *  whole fleet rather than one aircraft (listLandingsByAircraft above). Score is resolved
 *  by the caller (main/index.ts), same composition as listLandingsByAircraft's own
 *  fleetListLandings handler.
 *
 * @param db The database.
 * @returns The landings, with each flight's number, airports and aircraft.
 */
export function listAllLandings(db: WingLogDb): (Landing & {
  flightNumber: string | null
  aircraftRegistration: string
  /** Not part of the IPC-facing shape — only here so the caller can resolve a score
   *  against this landing's own aircraft without a second query per row. */
  icaoType: string | null
  depIcao: string
  arrIcao: string
})[] {
  return db
    .select({
      landing: landing,
      flightNumber: flight.flightNumber,
      depIcao: flight.depIcao,
      arrIcao: flight.arrIcao,
      aircraftRegistration: aircraft.registration,
      icaoType: aircraft.icaoType,
      simRegistration: flight.simRegistration,
      simIcaoType: flight.simIcaoType
    })
    .from(landing)
    .innerJoin(flight, eq(landing.flightId, flight.id))
    // Left, not inner — a free flight tracked with no fleet aircraft has a null
    // flight.aircraftId, which would otherwise silently drop its landings from this list
    // entirely. simRegistration/simIcaoType (below) stand in for the missing join instead.
    .leftJoin(aircraft, eq(flight.aircraftId, aircraft.id))
    .where(and(isNull(landing.deletedAt), isNull(flight.deletedAt)))
    .orderBy(desc(landing.touchdownTsUtc))
    .all()
    .map((row) => ({
      ...toLanding(row.landing),
      flightNumber: row.flightNumber,
      depIcao: row.depIcao,
      arrIcao: row.arrIcao,
      aircraftRegistration: row.aircraftRegistration ?? row.simRegistration ?? '—',
      icaoType: row.icaoType ?? row.simIcaoType
    }))
}

/**
 * See aircraft-repo.ts's listAircraftForSync for the shape/reasoning this mirrors.
 *
 * @param db The database.
 * @param since The sync cursor, or null for every row.
 * @returns The rows, oldest change first.
 */
export function listLandingsForSync(db: WingLogDb, since: string | null): (typeof landing.$inferSelect)[] {
  return rowsChangedSince(db.select().from(landing).all(), since)
}

/** See aircraft-repo.ts's upsertAircraftByUuid for the shape/reasoning this mirrors,
 *  including the last-write-wins-against-a-local-edit check.
 *
 * @param db The database.
 * @param input The pulled row.
 * @returns False when the local row is as new or newer, so nothing changed.
 */
export function upsertLandingByUuid(
  db: WingLogDb,
  input: Omit<typeof landing.$inferInsert, 'id'> & { uuid: string }
): boolean {
  const existing = db.select().from(landing).where(eq(landing.uuid, input.uuid)).get()
  if (!shouldApplyPulledRow(existing, input.updatedAt)) return false
  if (existing) db.update(landing).set(input).where(eq(landing.uuid, input.uuid)).run()
  else db.insert(landing).values(input).run()
  return true
}
