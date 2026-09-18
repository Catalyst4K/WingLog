import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import type { AircraftLandingRow, Landing } from '@shared/ipc'
import { aircraft, flight, landing } from './schema'
import type { WingLogDb } from './client'

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

export type NewLanding = Omit<Landing, 'id'>

/** The flight's most recent touchdown — the one Logbook's landing card defaults to
 *  (flightdeck-backend's docs/plans/multiple-landings.md). Kept alongside
 *  listLandingsByFlight below for callers that only ever cared about "the" landing. */
export function getLandingByFlight(db: WingLogDb, flightId: number): Landing | undefined {
  const row = db
    .select()
    .from(landing)
    .where(and(eq(landing.flightId, flightId), isNull(landing.deletedAt)))
    .orderBy(desc(landing.seq))
    .get()
  return row ? toLanding(row) : undefined
}

/** Every touchdown recorded for a flight, in the order they happened. */
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
 * touchdowns (flightdeck-backend's docs/plans/multiple-landings.md), but a re-capture of
 * the *same* touchdown (e.g. a replay) still replaces rather than duplicates. `set`
 * deliberately omits `uuid`: a re-capture of an existing landing keeps its original sync
 * identity rather than minting a new one, while a genuinely new row gets one from `values`
 * (flightdeck-backend/docs/plans/cloud-sync.md) — updatedAt bumps either way, so a
 * re-capture still re-syncs.
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
 *  landing records (the common case for a while) simply return an empty array. */
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
 *  sub-tab (flightdeck-backend's docs/plans/multiple-landings.md Phase 2/3), spanning the
 *  whole fleet rather than one aircraft (listLandingsByAircraft above). Score is resolved
 *  by the caller (main/index.ts), same composition as listLandingsByAircraft's own
 *  fleetListLandings handler. */
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
      icaoType: aircraft.icaoType
    })
    .from(landing)
    .innerJoin(flight, eq(landing.flightId, flight.id))
    .innerJoin(aircraft, eq(flight.aircraftId, aircraft.id))
    .where(and(isNull(landing.deletedAt), isNull(flight.deletedAt)))
    .orderBy(desc(landing.touchdownTsUtc))
    .all()
    .map((row) => ({
      ...toLanding(row.landing),
      flightNumber: row.flightNumber,
      depIcao: row.depIcao,
      arrIcao: row.arrIcao,
      aircraftRegistration: row.aircraftRegistration,
      icaoType: row.icaoType
    }))
}

/** See aircraft-repo.ts's listAircraftForSync for the shape/reasoning this mirrors. */
export function listLandingsForSync(db: WingLogDb, since: string | null): (typeof landing.$inferSelect)[] {
  const rows = db.select().from(landing).all()
  return rows
    .filter((row) => row.uuid !== null && row.updatedAt !== null && (since === null || row.updatedAt > since))
    .sort((a, b) => (a.updatedAt as string).localeCompare(b.updatedAt as string))
}

/** See aircraft-repo.ts's upsertAircraftByUuid for the shape/reasoning this mirrors,
 *  including the last-write-wins-against-a-local-edit check. */
export function upsertLandingByUuid(
  db: WingLogDb,
  input: Omit<typeof landing.$inferInsert, 'id'> & { uuid: string }
): boolean {
  const existing = db.select().from(landing).where(eq(landing.uuid, input.uuid)).get()
  if (existing) {
    if (existing.updatedAt !== null && typeof input.updatedAt === 'string' && existing.updatedAt >= input.updatedAt) {
      return false
    }
    db.update(landing).set(input).where(eq(landing.uuid, input.uuid)).run()
  } else {
    db.insert(landing).values(input).run()
  }
  return true
}
