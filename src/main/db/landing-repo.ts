import { randomUUID } from 'node:crypto'
import { and, desc, eq, isNull } from 'drizzle-orm'
import type { AircraftLandingRow, Landing } from '@shared/ipc'
import { flight, landing } from './schema'
import type { WingLogDb } from './client'

function toLanding(row: typeof landing.$inferSelect): Landing {
  return {
    id: row.id,
    flightId: row.flightId,
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

export function getLandingByFlight(db: WingLogDb, flightId: number): Landing | undefined {
  const row = db
    .select()
    .from(landing)
    .where(and(eq(landing.flightId, flightId), isNull(landing.deletedAt)))
    .get()
  return row ? toLanding(row) : undefined
}

/**
 * flight.flight_id is unique — at most one landing per flight, so a re-capture (e.g. a
 * rescan) replaces rather than duplicates. `set` deliberately omits `uuid`: a re-capture
 * of an existing landing keeps its original sync identity rather than minting a new one,
 * while a genuinely new row gets one from `values` (flightdeck-backend/docs/plans/
 * cloud-sync.md) — updatedAt bumps either way, so a re-capture still re-syncs.
 */
export function createLanding(db: WingLogDb, input: NewLanding): Landing {
  const now = new Date().toISOString()
  const [row] = db
    .insert(landing)
    .values({ ...input, uuid: randomUUID(), updatedAt: now })
    .onConflictDoUpdate({ target: landing.flightId, set: { ...input, updatedAt: now } })
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
