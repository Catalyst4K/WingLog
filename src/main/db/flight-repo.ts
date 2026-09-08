import { randomUUID } from 'node:crypto'
import { and, desc, eq, isNull } from 'drizzle-orm'
import type { Flight, FleetStats, LogbookStats, NewFlight, ProcedureSelection } from '@shared/ipc'
import { greatCircleDistanceNm } from '../airports/airport-search'
import { aircraft, flight, flightInvoice, landing, trackPoint } from './schema'
import type { WingLogDb } from './client'

function toFlight(row: typeof flight.$inferSelect): Flight {
  return {
    id: row.id,
    aircraftId: row.aircraftId,
    status: row.status,
    flightNumber: row.flightNumber,
    depIcao: row.depIcao,
    arrIcao: row.arrIcao,
    altnIcao: row.altnIcao,
    routeString: row.routeString,
    cruiseAltM: row.cruiseAltM,
    schedOutUtc: row.schedOutUtc,
    schedInUtc: row.schedInUtc,
    actualOutUtc: row.actualOutUtc,
    actualOffUtc: row.actualOffUtc,
    actualOnUtc: row.actualOnUtc,
    actualInUtc: row.actualInUtc,
    blockMinutes: row.blockMinutes,
    airMinutes: row.airMinutes,
    fuelPlannedKg: row.fuelPlannedKg,
    fuelOutKg: row.fuelOutKg,
    fuelInKg: row.fuelInKg,
    fuelBurnKg: row.fuelBurnKg,
    pax: row.pax,
    cargoKg: row.cargoKg,
    zfwKg: row.zfwKg,
    towKg: row.towKg,
    ldwKg: row.ldwKg,
    ofpId: row.ofpId,
    ofpJson: row.ofpJson,
    simVersion: row.simVersion,
    createdAt: row.createdAt,
    selectedDepartureRunway: row.selectedDepartureRunway,
    selectedSidIdent: row.selectedSidIdent,
    selectedSidTransition: row.selectedSidTransition,
    selectedStarIdent: row.selectedStarIdent,
    selectedStarTransition: row.selectedStarTransition,
    selectedApproachIdent: row.selectedApproachIdent,
    selectedApproachTransition: row.selectedApproachTransition
  }
}

function minutesBetween(startIso: string | null, endIso: string | null): number | null {
  if (!startIso || !endIso) return null
  return (new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000
}

export function listFlights(db: WingLogDb): Flight[] {
  // Order by id, not created_at: current_timestamp has 1-second resolution and two
  // flights created in the same second would otherwise tie with no defined order.
  return db.select().from(flight).where(isNull(flight.deletedAt)).orderBy(desc(flight.id)).all().map(toFlight)
}

/** An aircraft's completed flights, newest first — Fleet's per-tail flight list
 *  (docs/plans/fleet-redesign.md #2). Filtered in the query rather than in the renderer,
 *  since flightList() is already hundreds of rows on a well-used fleet and only grows. */
export function listFlightsByAircraft(db: WingLogDb, aircraftId: number): Flight[] {
  return db
    .select()
    .from(flight)
    .where(and(eq(flight.status, 'completed'), eq(flight.aircraftId, aircraftId), isNull(flight.deletedAt)))
    .orderBy(desc(flight.actualInUtc))
    .all()
    .map(toFlight)
}

export function getFlight(db: WingLogDb, id: number): Flight | undefined {
  const row = db.select().from(flight).where(eq(flight.id, id)).get()
  return row ? toFlight(row) : undefined
}

// uuid/updatedAt (flightdeck-backend/docs/plans/cloud-sync.md) are set explicitly on every
// write path here rather than left to a DB default — see schema.ts's aircraft.uuid
// comment for why. An update that forgets to bump updatedAt would silently never sync.
export function createFlight(db: WingLogDb, input: NewFlight): Flight {
  const [row] = db
    .insert(flight)
    .values({ ...input, uuid: randomUUID(), updatedAt: new Date().toISOString() })
    .returning()
    .all()
  return toFlight(row)
}

export interface HistoricalFlightInput {
  aircraftId: number
  depIcao: string
  arrIcao: string
  flightNumber: string | null
  actualOutUtc: string
  actualInUtc: string
}

/**
 * Inserts a flight that already happened — CSV logbook import (logbook-import.ts), not
 * the live start/off/on/complete tracking lifecycle above. Goes straight to 'completed'
 * with block time derived from the two timestamps; there's no off/on or fuel data in a
 * summary logbook export, so those stay null same as any other field the source doesn't
 * provide.
 */
export function createHistoricalFlight(db: WingLogDb, input: HistoricalFlightInput): Flight {
  const [row] = db
    .insert(flight)
    .values({
      aircraftId: input.aircraftId,
      status: 'completed',
      flightNumber: input.flightNumber,
      depIcao: input.depIcao,
      arrIcao: input.arrIcao,
      actualOutUtc: input.actualOutUtc,
      actualInUtc: input.actualInUtc,
      blockMinutes: minutesBetween(input.actualOutUtc, input.actualInUtc),
      uuid: randomUUID(),
      updatedAt: new Date().toISOString()
    })
    .returning()
    .all()
  return toFlight(row)
}

/** Block-out: the flight goes 'active' and tracking begins. */
export function startFlight(
  db: WingLogDb,
  id: number,
  fuelOutKg: number,
  simVersion?: string
): Flight | undefined {
  const [row] = db
    .update(flight)
    .set({
      status: 'active',
      actualOutUtc: new Date().toISOString(),
      fuelOutKg,
      simVersion,
      updatedAt: new Date().toISOString()
    })
    .where(eq(flight.id, id))
    .returning()
    .all()
  return row ? toFlight(row) : undefined
}

/**
 * Corrects the provisional fuel_out_kg written by startFlight, once the phase machine
 * first leaves 'preflight' (TrackingController, on the preflight -> pushback transition).
 * The value captured at the instant tracking starts can't be trusted as "fuel loaded" —
 * SimConnect can report stale/leftover telemetry for a while after a flight reload (the
 * same garbage-data window spike-flight-reload.ts found for altitude, evidently not
 * limited to it — a real case, flight #182, showed a plausible-looking ~10,187kg reading
 * that was actually a reload artifact, not the aircraft's genuine ~3,000kg default), and
 * ground fuel service (GSX, an EFB) happens after that too, while the aircraft is still
 * stationary and tracking has therefore already started. Waiting for the first real
 * ground-movement/engine-start signal sidesteps both: by then the reload window has long
 * since cleared and any deliberate defuel/refuel has already settled.
 */
export function finalizeFuelOut(db: WingLogDb, id: number, fuelOutKg: number): Flight | undefined {
  const [row] = db
    .update(flight)
    .set({ fuelOutKg, updatedAt: new Date().toISOString() })
    .where(eq(flight.id, id))
    .returning()
    .all()
  return row ? toFlight(row) : undefined
}

/** Liftoff — the takeoff → climb transition. */
export function recordOff(db: WingLogDb, id: number): Flight | undefined {
  const [row] = db
    .update(flight)
    .set({ actualOffUtc: new Date().toISOString(), updatedAt: new Date().toISOString() })
    .where(eq(flight.id, id))
    .returning()
    .all()
  return row ? toFlight(row) : undefined
}

/** Touchdown — the descent → landing transition. */
export function recordOn(db: WingLogDb, id: number): Flight | undefined {
  const [row] = db
    .update(flight)
    .set({ actualOnUtc: new Date().toISOString(), updatedAt: new Date().toISOString() })
    .where(eq(flight.id, id))
    .returning()
    .all()
  return row ? toFlight(row) : undefined
}

/** Block-in: shutdown reached. Derives block/air time and fuel burn from the timestamps already recorded. */
export function completeFlight(db: WingLogDb, id: number, fuelInKg: number): Flight | undefined {
  const existing = getFlight(db, id)
  if (!existing) return undefined

  const actualInUtc = new Date().toISOString()
  const [row] = db
    .update(flight)
    .set({
      status: 'completed',
      actualInUtc,
      fuelInKg,
      blockMinutes: minutesBetween(existing.actualOutUtc, actualInUtc),
      airMinutes: minutesBetween(existing.actualOffUtc, existing.actualOnUtc),
      fuelBurnKg: existing.fuelOutKg != null ? existing.fuelOutKg - fuelInKg : null,
      updatedAt: actualInUtc
    })
    .where(eq(flight.id, id))
    .returning()
    .all()

  // Keeps the Dispatch "plan a flight" departure-airport autofill accurate over time —
  // otherwise it'd only ever reflect wherever the aircraft was manually set to once.
  // Only wired into the real-time completion path (TrackingController → completeFlight),
  // not CSV-imported historical flights (logbook-import.ts's createHistoricalFlight),
  // since an import isn't guaranteed to process rows in chronological order.
  if (row)
    db.update(aircraft)
      .set({ currentIcao: existing.arrIcao })
      .where(eq(aircraft.id, existing.aircraftId))
      .run()

  return row ? toFlight(row) : undefined
}

/** User cancelled tracking mid-flight — stop recording without pretending it completed normally. */
export function abandonFlight(db: WingLogDb, id: number): Flight | undefined {
  const [row] = db
    .update(flight)
    .set({ status: 'abandoned', updatedAt: new Date().toISOString() })
    .where(eq(flight.id, id))
    .returning()
    .all()
  return row ? toFlight(row) : undefined
}

/**
 * Removes a flight — a bad test entry, or any flight that logged wrong data (e.g. a
 * phase-machine hiccup that produced a nonsense fuel-burn figure). Soft-deletes the flight
 * and cascades the same tombstone to its `landing`/`flightInvoice` rows (flightdeck-backend/
 * docs/plans/cloud-sync-v2.md #3a) — all three are synced, so a hard DELETE would just get
 * resurrected by the next pull on another device. `trackPoint` is never synced and stays
 * hard-deleted, same as before. One transaction so a mid-way failure can't leave the flight
 * tombstoned but its dependents still visible, or vice versa.
 */
export function deleteFlight(db: WingLogDb, id: number): void {
  const now = new Date().toISOString()
  db.transaction((tx) => {
    tx.delete(trackPoint).where(eq(trackPoint.flightId, id)).run()
    tx.update(landing).set({ deletedAt: now, updatedAt: now }).where(eq(landing.flightId, id)).run()
    tx.update(flightInvoice).set({ deletedAt: now, updatedAt: now }).where(eq(flightInvoice.flightId, id)).run()
    tx.update(flight).set({ deletedAt: now, updatedAt: now }).where(eq(flight.id, id)).run()
  })
}

/**
 * The app only ever means one flight to be "in progress" (planned or active) at a time —
 * pressing "Fly" on a new plan replaces whatever was already planned rather than piling
 * up alongside it. Called before creating a new flight; a no-op if nothing is planned.
 */
export function abandonAllPlanned(db: WingLogDb): void {
  db.update(flight)
    .set({ status: 'abandoned', updatedAt: new Date().toISOString() })
    .where(eq(flight.status, 'planned'))
    .run()
}

/** Stores the flight's derived flown-route polyline (route-simplify.ts), computed at
 *  completion — see schema.ts's flownRouteJson comment. Best-effort: called from the same
 *  fire-and-forget spot as the GSX invoice snapshot, so a failure here must never affect
 *  the flight record that's already been marked completed. */
export function setFlownRoute(db: WingLogDb, id: number, flownRouteJson: string): void {
  db.update(flight)
    .set({ flownRouteJson, updatedAt: new Date().toISOString() })
    .where(eq(flight.id, id))
    .run()
}

/** Writes the live-selected procedures at flight completion (TrackingController), the
 *  later of the two writes ProcedureSelection's doc comment describes — overwrites
 *  whatever createFlight wrote at save time, since the pilot may have changed things
 *  mid-flight after ATC actually assigned a runway/STAR/approach. */
export function setSelectedProcedures(db: WingLogDb, id: number, selection: ProcedureSelection): void {
  db.update(flight)
    .set({
      selectedDepartureRunway: selection.departureRunway,
      selectedSidIdent: selection.sidIdent,
      selectedSidTransition: selection.sidTransition,
      selectedStarIdent: selection.starIdent,
      selectedStarTransition: selection.starTransition,
      selectedApproachIdent: selection.approachIdent,
      selectedApproachTransition: selection.approachTransition,
      updatedAt: new Date().toISOString()
    })
    .where(eq(flight.id, id))
    .run()
}

export function listCompletedFlights(db: WingLogDb): Flight[] {
  return db
    .select()
    .from(flight)
    .where(and(eq(flight.status, 'completed'), isNull(flight.deletedAt)))
    .orderBy(desc(flight.actualInUtc))
    .all()
    .map(toFlight)
}

/** Logbook's summary row above the flight table. totalNm is great-circle dep→arr
 *  distance (airport-search.ts), not the actual flown track — good enough for a summary
 *  total, and unlike a flown-route length, available for a CSV-imported flight too. */
export function getLogbookStats(db: WingLogDb): LogbookStats {
  const completed = listCompletedFlights(db)
  const totalBlockMinutes = completed.reduce((sum, f) => sum + (f.blockMinutes ?? 0), 0)
  const totalNm = completed.reduce((sum, f) => sum + (greatCircleDistanceNm(f.depIcao, f.arrIcao) ?? 0), 0)
  return { totalFlights: completed.length, totalBlockMinutes, totalNm }
}

/**
 * One row per aircraft with a completed flight, derived live from `flight` rather than
 * `Aircraft.totalHours`/`totalCycles` — nothing currently writes to those columns, so
 * they can't be trusted as a running total. Aircraft with no completed flights are
 * omitted rather than shown with zeroes.
 */
export function getFleetStats(db: WingLogDb): FleetStats[] {
  const completed = listCompletedFlights(db) // newest first
  const aircraftById = new Map(
    db
      .select()
      .from(aircraft)
      .all()
      .map((row) => [row.id, row.registration])
  )

  const byAircraft = new Map<number, FleetStats>()
  for (const f of completed) {
    const registration = aircraftById.get(f.aircraftId)
    if (!registration) continue // orphaned flight row, e.g. its aircraft was deleted

    const existing = byAircraft.get(f.aircraftId)
    if (existing) {
      existing.totalHours += (f.blockMinutes ?? 0) / 60
      existing.totalCycles += 1
    } else {
      byAircraft.set(f.aircraftId, {
        aircraftId: f.aircraftId,
        registration,
        totalHours: (f.blockMinutes ?? 0) / 60,
        totalCycles: 1,
        lastArrIcao: f.arrIcao,
        lastFlightInUtc: f.actualInUtc
      })
    }
  }
  return [...byAircraft.values()].sort((a, b) => a.registration.localeCompare(b.registration))
}

/** See aircraft-repo.ts's listAircraftForSync for the shape/reasoning this mirrors. */
export function listFlightsForSync(db: WingLogDb, since: string | null): (typeof flight.$inferSelect)[] {
  const rows = db.select().from(flight).all()
  return rows
    .filter((row) => row.uuid !== null && row.updatedAt !== null && (since === null || row.updatedAt > since))
    .sort((a, b) => (a.updatedAt as string).localeCompare(b.updatedAt as string))
}

/** See aircraft-repo.ts's upsertAircraftByUuid for the shape/reasoning this mirrors,
 *  including the last-write-wins-against-a-local-edit check. */
export function upsertFlightByUuid(
  db: WingLogDb,
  input: Omit<typeof flight.$inferInsert, 'id'> & { uuid: string }
): boolean {
  const existing = db.select().from(flight).where(eq(flight.uuid, input.uuid)).get()
  if (existing) {
    if (existing.updatedAt !== null && typeof input.updatedAt === 'string' && existing.updatedAt >= input.updatedAt) {
      return false
    }
    db.update(flight).set(input).where(eq(flight.uuid, input.uuid)).run()
  } else {
    db.insert(flight).values(input).run()
  }
  return true
}

/** Local integer id for a flight referenced by its sync uuid — sync-engine.ts resolves a
 *  pulled row's parent-table reference this way (e.g. flightInvoice's flightUuid) rather
 *  than trusting a remote integer id, which is meaningless locally. Undefined if the
 *  parent hasn't been pulled yet — sync-engine.ts pulls in dependency order (aircraft,
 *  then flight, then landing/flightInvoice) specifically so this always resolves. */
export function getFlightIdByUuid(db: WingLogDb, uuid: string): number | undefined {
  return db.select({ id: flight.id }).from(flight).where(eq(flight.uuid, uuid)).get()?.id
}

/** The reverse of getFlightIdByUuid — sync-engine.ts's push side needs a flight's uuid
 *  (not its local id, meaningless remotely) to serialize landing/flightInvoice's flightId. */
export function getFlightUuidById(db: WingLogDb, id: number): string | null | undefined {
  return db.select({ uuid: flight.uuid }).from(flight).where(eq(flight.id, id)).get()?.uuid
}
