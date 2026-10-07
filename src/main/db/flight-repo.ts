/**
 * Flights in the database: the tracking lifecycle (planned, active, completed), free and imported
 * flights, the Logbook's lists and statistics, and the sync helpers. Deleting is a soft delete, so
 * anything user-facing filters `deletedAt`.
 */
import { randomUUID } from 'node:crypto'
import { and, desc, eq, getTableColumns, isNotNull, isNull, or, sql } from 'drizzle-orm'
import type { NewFreeFlightInput, PausedInterval } from '@shared/ipc'
import type {
  AircraftLastParked,
  Flight,
  FleetStats,
  LogbookFlight,
  LogbookStats,
  NewFlight,
  ProcedureSelection
} from '@shared/ipc'
import { greatCircleDistanceNm } from '../airports/airport-search'
import { rememberAircraftForTitle } from './settings-repo'
import { aircraft, flight, flightInvoice, landing, trackPoint } from './schema'

// Live in src/shared so the host-side tracking code can use them without importing the database.
export type { NewFreeFlightInput, PausedInterval } from '@shared/ipc'
import type { WingLogDb } from './client'
import { rowsChangedSince, shouldApplyPulledRow } from './sync-rows'

/**
 * A database row as a Flight.
 *
 * @param row The `flight` row.
 * @returns The flight as the app sees it.
 */
function toFlight(row: typeof flight.$inferSelect): Flight {
  return {
    id: row.id,
    aircraftId: row.aircraftId,
    simRegistration: row.simRegistration,
    simIcaoType: row.simIcaoType,
    simTitle: row.simTitle,
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
    selectedApproachTransition: row.selectedApproachTransition,
    selectedArrivalIcao: row.selectedArrivalIcao
  }
}

/**
 * Minutes between two ISO times.
 *
 * @param startIso The start, or null.
 * @param endIso The end, or null.
 * @returns Minutes, or null when either end is missing.
 */
function minutesBetween(startIso: string | null, endIso: string | null): number | null {
  if (!startIso || !endIso) return null
  return (new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000
}

/** Same as minutesBetween, but with any paused wall-clock time inside [startIso, endIso]
 *  subtracted first — a pause interval outside that window (e.g. a taxi-in pause after
 *  touchdown, which doesn't touch airMinutes) contributes nothing. Floored at 0 so clock
 *  skew between the paused/resumed events and the off/on timestamps can't produce a
 *  negative duration.
 *
 * @param startIso The start, or null.
 * @param endIso The end, or null.
 * @param pausedIntervals When the sim was paused.
 * @returns Minutes, or null when either end is missing.
 */
function minutesBetweenExcludingPauses(
  startIso: string | null,
  endIso: string | null,
  pausedIntervals: PausedInterval[]
): number | null {
  const raw = minutesBetween(startIso, endIso)
  if (raw === null || !startIso || !endIso) return raw
  const startMs = new Date(startIso).getTime()
  const endMs = new Date(endIso).getTime()
  let pausedMs = 0
  for (const interval of pausedIntervals) {
    const overlapStart = Math.max(new Date(interval.startIso).getTime(), startMs)
    const overlapEnd = Math.min(new Date(interval.endIso).getTime(), endMs)
    if (overlapEnd > overlapStart) pausedMs += overlapEnd - overlapStart
  }
  return Math.max(0, raw - pausedMs / 60_000)
}

/**
 * Every flight that isn't deleted, whatever its status.
 *
 * @param db The database.
 * @returns The flights, newest first.
 */
export function listFlights(db: WingLogDb): Flight[] {
  // Order by id, not created_at: current_timestamp has 1-second resolution and two
  // flights created in the same second would otherwise tie with no defined order.
  return db.select().from(flight).where(isNull(flight.deletedAt)).orderBy(desc(flight.id)).all().map(toFlight)
}

/**
 * Every flight that isn't deleted, newest first, without the OFP text. The OFP is about 1 MB of JSON per flight, so the
 * whole list with it was 47 MB over IPC on every Dispatch and Track open (measured 2026-10-08, 200 flights); a page that
 * needs one OFP fetches that flight by id.
 *
 * @param db The database.
 * @returns The flights, newest first, with `hasOfp` in place of the OFP.
 */
export function listFlightSummaries(db: WingLogDb): LogbookFlight[] {
  const { ofpJson, ...columns } = getTableColumns(flight)
  return db
    .select({ ...columns, hasOfp: sql<number>`${ofpJson} is not null` })
    .from(flight)
    .where(isNull(flight.deletedAt))
    .orderBy(desc(flight.id))
    .all()
    .map(({ hasOfp, ...row }) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the OFP is dropped on purpose
      const { ofpJson: _omitted, ...rest } = toFlight({ ...row, ofpJson: null })
      return { ...rest, hasOfp: hasOfp === 1 }
    })
}

/** An aircraft's completed flights, newest first — Fleet's per-tail flight list
 *  (docs/plans/fleet-redesign.md #2). Filtered in the query rather than in the renderer,
 *  since flightList() is already hundreds of rows on a well-used fleet and only grows.
 *
 * @param db The database.
 * @param aircraftId The fleet aircraft.
 * @returns The flights.
 */
export function listFlightsByAircraft(db: WingLogDb, aircraftId: number): Flight[] {
  return db
    .select()
    .from(flight)
    .where(and(eq(flight.status, 'completed'), eq(flight.aircraftId, aircraftId), isNull(flight.deletedAt)))
    .orderBy(desc(flight.actualInUtc))
    .all()
    .map(toFlight)
}

/**
 * A flight by id, including a deleted one. Use getLiveFlight for anything user-facing.
 *
 * @param db The database.
 * @param id The flight.
 * @returns The flight, or undefined.
 */
export function getFlight(db: WingLogDb, id: number): Flight | undefined {
  const row = db.select().from(flight).where(eq(flight.id, id)).get()
  return row ? toFlight(row) : undefined
}

/**
 * getFlight, but never a deleted (tombstoned) flight — for anything user-facing.
 *
 * @param db The database.
 * @param id The flight.
 * @returns The flight, or undefined when missing or deleted.
 */
export function getLiveFlight(db: WingLogDb, id: number): Flight | undefined {
  const row = db
    .select()
    .from(flight)
    .where(and(eq(flight.id, id), isNull(flight.deletedAt)))
    .get()
  return row ? toFlight(row) : undefined
}

/** The one flight currently "in progress" — planned (Dispatch's "Fly" pressed, tracking
 *  not yet started) or active (already tracking) — if any:
 *  used to restore Dispatch's own view of that flight after a restart (it otherwise only
 *  has its own in-memory `dispatchOfp`, which doesn't survive one, unlike Track's list,
 *  which already reads this same DB state directly). Same one-at-a-time invariant as
 *  flightCreate relies on, so the first match is authoritative.
 *
 * @param db The database.
 * @returns The planned or active flight, or undefined.
 */
export function getInProgressFlight(db: WingLogDb): Flight | undefined {
  const row = db
    .select()
    .from(flight)
    .where(and(or(eq(flight.status, 'planned'), eq(flight.status, 'active')), isNull(flight.deletedAt)))
    .get()
  return row ? toFlight(row) : undefined
}

// uuid/updatedAt (winglog-backend/docs/plans/cloud-sync.md) are set explicitly on every
// write path here rather than left to a DB default — see schema.ts's aircraft.uuid
// comment for why. An update that forgets to bump updatedAt would silently never sync.
/**
 * Creates a planned flight.
 *
 * @param db The database.
 * @param input The flight from Dispatch.
 * @returns The new planned flight.
 */
export function createFlight(db: WingLogDb, input: NewFlight): Flight {
  const [row] = db
    .insert(flight)
    .values({ ...input, uuid: randomUUID(), updatedAt: new Date().toISOString() })
    .returning()
    .all()
  return toFlight(row)
}

/**
 * Creates a flight that skips the 'planned' stage entirely — free-flight-tracking.md:
 * tracking a flight the pilot is already in, with no SimBrief plan and no Dispatch "Fly"
 * press to transition from. Goes straight to 'active' with actualOutUtc/fuelOutKg/simVersion
 * already set — the same fields startFlight otherwise fills in on the planned -> active
 * transition, written here directly since there's no earlier 'planned' row for this flight.
 *
 * @param db The database.
 * @param input The aircraft, airports, fuel and sim version.
 * @returns The new active flight.
 */
export function createFreeFlight(db: WingLogDb, input: NewFreeFlightInput): Flight {
  const [row] = db
    .insert(flight)
    .values({
      aircraftId: input.aircraftId,
      simRegistration: input.simRegistration ?? null,
      simIcaoType: input.simIcaoType ?? null,
      simTitle: input.simTitle ?? null,
      status: 'active',
      flightNumber: input.flightNumber,
      depIcao: input.depIcao,
      arrIcao: input.arrIcao,
      actualOutUtc: new Date().toISOString(),
      fuelOutKg: input.fuelOutKg,
      simVersion: input.simVersion,
      uuid: randomUUID(),
      updatedAt: new Date().toISOString()
    })
    .returning()
    .all()
  return toFlight(row)
}

/**
 * Overwrites a free flight's arrival with wherever it actually landed
 * (free-flight-tracking.md, "Arrival is resolved, not filed") — called at touchdown and
 * again at completion in case of a taxi to a different field, always before completeFlight
 * runs (that function copies arr_icao into aircraft.current_icao). The caller
 * (TrackingController) scopes this to free flights only — a dispatched flight keeps its
 * filed arrival even on a real diversion, a separate, already-known gap this doesn't touch.
 *
 * @param db The database.
 * @param id The flight.
 * @param arrIcao Where it landed.
 */
export function setArrIcao(db: WingLogDb, id: number, arrIcao: string): void {
  db.update(flight).set({ arrIcao, updatedAt: new Date().toISOString() }).where(eq(flight.id, id)).run()
}

/**
 * A free flight's departure, set by the pilot after tracking has started (v1.1.2).
 *
 * @param db The database.
 * @param id The flight.
 * @param depIcao The departure airport.
 */
export function setDepIcao(db: WingLogDb, id: number, depIcao: string): void {
  db.update(flight).set({ depIcao, updatedAt: new Date().toISOString() }).where(eq(flight.id, id)).run()
}

/**
 * Links a fleet aircraft to a flight that was tracked as a free flight with no aircraft at
 * all — Callum's follow-up call on free-flight-tracking.md: adding to the fleet doesn't have
 * to happen at flight-start time, it can happen later from Logbook once the pilot decides the
 * aircraft is worth keeping. Nulls simRegistration/simIcaoType/simTitle to preserve the
 * schema's "always null together with a non-null aircraftId" invariant, backfills
 * aircraft.currentIcao the same way completeFlight does (this flight already completed
 * without ever going through that write, since it had no aircraft to write it for), and
 * remembers the flight's own simTitle -> aircraft mapping so the next free flight in the same
 * add-on auto-matches, same as if fleet creation had happened inline at start.
 *
 * @param db The database.
 * @param id The flight.
 * @param aircraftId The fleet aircraft.
 * @returns The updated flight, or undefined when the flight doesn't exist.
 */
export function linkAircraftToFlight(db: WingLogDb, id: number, aircraftId: number): Flight | undefined {
  const existing = getFlight(db, id)
  if (!existing) return undefined

  const [row] = db
    .update(flight)
    .set({
      aircraftId,
      simRegistration: null,
      simIcaoType: null,
      simTitle: null,
      updatedAt: new Date().toISOString()
    })
    .where(eq(flight.id, id))
    .returning()
    .all()
  if (!row) return undefined

  if (existing.arrIcao !== 'ZZZZ') {
    db.update(aircraft).set({ currentIcao: existing.arrIcao }).where(eq(aircraft.id, aircraftId)).run()
  }
  if (existing.simTitle) rememberAircraftForTitle(db, existing.simTitle, aircraftId)

  return toFlight(row)
}

export interface HistoricalFlightInput {
  aircraftId: number
  depIcao: string
  arrIcao: string
  flightNumber: string | null
  actualOutUtc: string
  actualInUtc: string
  /** Only present when the source file carries them (WingLog's own export does; SimToolkitPro's doesn't). */
  airMinutes?: number | null
  fuelOutKg?: number | null
  fuelInKg?: number | null
  fuelBurnKg?: number | null
}

/**
 * Inserts a flight that already happened — CSV logbook import (logbook-import.ts), not
 * the live start/off/on/complete tracking lifecycle above. Goes straight to 'completed'
 * with block time derived from the two timestamps; there's no off/on or fuel data in a
 * summary logbook export, so those stay null same as any other field the source doesn't
 * provide.
 *
 * @param db The database.
 * @param input The imported flight.
 * @returns The new completed flight.
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
      airMinutes: input.airMinutes ?? null,
      fuelOutKg: input.fuelOutKg ?? null,
      fuelInKg: input.fuelInKg ?? null,
      fuelBurnKg: input.fuelBurnKg ?? null,
      uuid: randomUUID(),
      updatedAt: new Date().toISOString()
    })
    .returning()
    .all()
  return toFlight(row)
}

/**
 * Block-out: the flight goes 'active' and tracking begins.
 *
 * @param db The database.
 * @param id The flight.
 * @param fuelOutKg Fuel on board now, provisional (see finalizeFuelOut).
 * @param simVersion The sim's version, when known.
 * @returns The updated flight, or undefined when it doesn't exist.
 */
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
 * Corrects the provisional fuel_out_kg written by startFlight, once the phase machine first leaves 'preflight'
 * (TrackingController, on the preflight -> pushback transition). The value captured when tracking starts can't be trusted as
 * "fuel loaded": SimConnect can report stale telemetry for a while after a flight reload (a ~10,187 kg reading that was a
 * reload artifact, not the aircraft's ~3,000 kg default), and ground fuel service (GSX, an EFB) happens after tracking has
 * started, while the aircraft is still stationary. Waiting for the first ground-movement/engine-start signal sidesteps both.
 *
 * @param db The database.
 * @param id The flight.
 * @param fuelOutKg Fuel on board at the first movement.
 * @returns The updated flight, or undefined when it doesn't exist.
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

/**
 * Liftoff — the takeoff → climb transition.
 *
 * @param db The database.
 * @param id The flight.
 * @returns The updated flight, or undefined when it doesn't exist.
 */
export function recordOff(db: WingLogDb, id: number): Flight | undefined {
  const [row] = db
    .update(flight)
    .set({ actualOffUtc: new Date().toISOString(), updatedAt: new Date().toISOString() })
    .where(eq(flight.id, id))
    .returning()
    .all()
  return row ? toFlight(row) : undefined
}

/**
 * Touchdown — the descent → landing transition.
 *
 * @param db The database.
 * @param id The flight.
 * @returns The updated flight, or undefined when it doesn't exist.
 */
export function recordOn(db: WingLogDb, id: number): Flight | undefined {
  const [row] = db
    .update(flight)
    .set({ actualOnUtc: new Date().toISOString(), updatedAt: new Date().toISOString() })
    .where(eq(flight.id, id))
    .returning()
    .all()
  return row ? toFlight(row) : undefined
}

/**
 * Block-in: shutdown reached. Derives block/air time and fuel burn from the timestamps already recorded. `pausedIntervals`,
 * the wall-clock spans the sim reported itself paused (TrackingController tracks them from SimConnectService's 'paused'
 * event; separate from resume-track-cleanup, which is about a full app/sim restart), are excluded from both stats: both are a
 * plain wall-clock difference, so pausing the sim for an hour mid-cruise would otherwise add that hour to the flight.
 *
 * @param db The database.
 * @param id The flight.
 * @param fuelInKg Fuel on board at shutdown.
 * @param pausedIntervals When the sim was paused, left out of block and air time.
 * @returns The completed flight, or undefined when it doesn't exist.
 */
export function completeFlight(
  db: WingLogDb,
  id: number,
  fuelInKg: number,
  pausedIntervals: PausedInterval[] = []
): Flight | undefined {
  const existing = getFlight(db, id)
  if (!existing) return undefined

  const actualInUtc = new Date().toISOString()
  const [row] = db
    .update(flight)
    .set({
      status: 'completed',
      actualInUtc,
      fuelInKg,
      blockMinutes: minutesBetweenExcludingPauses(existing.actualOutUtc, actualInUtc, pausedIntervals),
      airMinutes: minutesBetweenExcludingPauses(existing.actualOffUtc, existing.actualOnUtc, pausedIntervals),
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
  // since an import isn't guaranteed to process rows in chronological order. Skipped
  // entirely for a free flight tracked with no fleet aircraft (aircraftId null) — there's
  // no aircraft record to update.
  if (row && existing.aircraftId != null)
    db.update(aircraft)
      .set({ currentIcao: existing.arrIcao })
      .where(eq(aircraft.id, existing.aircraftId))
      .run()

  return row ? toFlight(row) : undefined
}

/** User cancelled tracking mid-flight, discarded an orphaned crash-recovery flight (trackingDiscardOrphaned), or cancelled one
 *  that never got past 'planned' (flightCancel): deletes it outright via the same cascade as deleteFlight below, rather than
 *  leaving an inert 'abandoned' row (and, if it was tracked, its full track_point history) in the database. `FlightStatus`
 *  keeps the `'abandoned'` value for historical rows already in that state; nothing new is left there.
 *
 * @param db The database.
 * @param id The flight.
 */
export function abandonFlight(db: WingLogDb, id: number): void {
  deleteFlight(db, id)
}

/**
 * Removes a flight — a bad test entry, or any flight that logged wrong data (e.g. a
 * phase-machine hiccup that produced a nonsense fuel-burn figure). Soft-deletes the flight
 * and cascades the same tombstone to its `landing`/`flightInvoice` rows (winglog-backend/
 * docs/plans/cloud-sync-v2.md #3a) — all three are synced, so a hard DELETE would just get
 * resurrected by the next pull on another device. `trackPoint` is never synced and stays
 * hard-deleted, same as before. One transaction so a mid-way failure can't leave the flight
 * tombstoned but its dependents still visible, or vice versa.
 *
 * @param db The database.
 * @param id The flight.
 */
export function deleteFlight(db: WingLogDb, id: number): void {
  const now = new Date().toISOString()
  db.transaction((tx) => {
    tx.delete(trackPoint).where(eq(trackPoint.flightId, id)).run()
    tx.update(landing).set({ deletedAt: now, updatedAt: now }).where(eq(landing.flightId, id)).run()
    tx.update(flightInvoice)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(flightInvoice.flightId, id))
      .run()
    tx.update(flight).set({ deletedAt: now, updatedAt: now }).where(eq(flight.id, id)).run()
  })
}

/**
 * The app only ever means one flight to be "in progress" (planned or active) at a time —
 * pressing "Fly" on a new plan replaces whatever was already planned rather than piling
 * up alongside it. Called before creating a new flight; a no-op if nothing is planned.
 *
 * @param db The database.
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
 *  the flight record that's already been marked completed.
 *
 * @param db The database.
 * @param id The flight.
 * @param flownRouteJson The simplified route, as JSON.
 */
export function setFlownRoute(db: WingLogDb, id: number, flownRouteJson: string): void {
  db.update(flight)
    .set({ flownRouteJson, updatedAt: new Date().toISOString() })
    .where(eq(flight.id, id))
    .run()
}

/** Writes the live-selected procedures at flight completion (TrackingController), the
 *  later of the two writes ProcedureSelection's doc comment describes — overwrites
 *  whatever createFlight wrote at save time, since the pilot may have changed things
 *  mid-flight after ATC actually assigned a runway/STAR/approach.
 *
 * @param db The database.
 * @param id The flight.
 * @param selection The runway and procedures flown.
 */
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
      selectedArrivalIcao: selection.arrivalIcao,
      updatedAt: new Date().toISOString()
    })
    .where(eq(flight.id, id))
    .run()
}

/** Every completed flight, newest first, *without* the OFP text — see LogbookFlight. The
 *  column is left out of the SELECT itself, so SQLite never reads those ~90 KB blobs either;
 *  the stats/score/fleet summaries built on top of this got the same saving for free.
 *
 * @param db The database.
 * @returns The flights, with `hasOfp` in place of the OFP.
 */
export function listCompletedFlights(db: WingLogDb): LogbookFlight[] {
  const { ofpJson, ...columns } = getTableColumns(flight)
  return db
    .select({ ...columns, hasOfp: sql<number>`${ofpJson} is not null` })
    .from(flight)
    .where(and(eq(flight.status, 'completed'), isNull(flight.deletedAt)))
    .orderBy(desc(flight.actualInUtc))
    .all()
    .map(({ hasOfp, ...row }) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the OFP is dropped on purpose
      const { ofpJson: _omitted, ...rest } = toFlight({ ...row, ofpJson: null })
      return { ...rest, hasOfp: hasOfp === 1 }
    })
}

/** Logbook's summary row above the flight table. totalNm is great-circle dep→arr
 *  distance (airport-search.ts), not the actual flown track — good enough for a summary
 *  total, and unlike a flown-route length, available for a CSV-imported flight too.
 *
 * @param db The database.
 * @returns The number of flights, total block minutes and total distance.
 */
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
 *
 * @param db The database.
 * @returns One row per aircraft, by registration.
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
    if (f.aircraftId == null) continue // free flight tracked with no fleet aircraft
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

/**
 * See aircraft-repo.ts's listAircraftForSync for the shape/reasoning this mirrors.
 *
 * @param db The database.
 * @param since The sync cursor, or null for every row.
 * @returns The rows, oldest change first.
 */
export function listFlightsForSync(db: WingLogDb, since: string | null): (typeof flight.$inferSelect)[] {
  return rowsChangedSince(db.select().from(flight).all(), since)
}

/** See aircraft-repo.ts's upsertAircraftByUuid for the shape/reasoning this mirrors,
 *  including the last-write-wins-against-a-local-edit check.
 *
 * @param db The database.
 * @param input The pulled row.
 * @returns False when the local row is as new or newer, so nothing changed.
 */
export function upsertFlightByUuid(
  db: WingLogDb,
  input: Omit<typeof flight.$inferInsert, 'id'> & { uuid: string }
): boolean {
  const existing = db.select().from(flight).where(eq(flight.uuid, input.uuid)).get()
  if (!shouldApplyPulledRow(existing, input.updatedAt)) return false
  if (existing) db.update(flight).set(input).where(eq(flight.uuid, input.uuid)).run()
  else db.insert(flight).values(input).run()
  return true
}

/** Local integer id for a flight referenced by its sync uuid — sync-engine.ts resolves a
 *  pulled row's parent-table reference this way (e.g. flightInvoice's flightUuid) rather
 *  than trusting a remote integer id, which is meaningless locally. Undefined if the
 *  parent hasn't been pulled yet — sync-engine.ts pulls in dependency order (aircraft,
 *  then flight, then landing/flightInvoice) specifically so this always resolves.
 *
 * @param db The database.
 * @param uuid The flight's sync uuid.
 * @returns The local id, or undefined.
 */
export function getFlightIdByUuid(db: WingLogDb, uuid: string): number | undefined {
  return db.select({ id: flight.id }).from(flight).where(eq(flight.uuid, uuid)).get()?.id
}

/** The reverse of getFlightIdByUuid — sync-engine.ts's push side needs a flight's uuid
 *  (not its local id, meaningless remotely) to serialize landing/flightInvoice's flightId.
 *
 * @param db The database.
 * @param id The local id.
 * @returns The sync uuid, null for a row without one, or undefined when missing.
 */
export function getFlightUuidById(db: WingLogDb, id: number): string | null | undefined {
  return db.select({ uuid: flight.uuid }).from(flight).where(eq(flight.id, id)).get()?.uuid
}

/**
 * Where the aircraft finished (stand-positions.md) — written once, after completion.
 *
 * @param db The database.
 * @param id The flight.
 * @param icao The airport.
 * @param stand The stand's name.
 */
export function setParkedStand(db: WingLogDb, id: number, icao: string, stand: string): void {
  db.update(flight)
    .set({ parkedStandIcao: icao, parkedStand: stand, updatedAt: new Date().toISOString() })
    .where(eq(flight.id, id))
    .run()
}

/**
 * Each fleet aircraft's latest completed (not deleted) flight that recorded a stand.
 *
 * @param db The database.
 * @returns One entry per aircraft that has one.
 */
export function listLastParkedByAircraft(db: WingLogDb): AircraftLastParked[] {
  const rows = db
    .select({ aircraftId: flight.aircraftId, icao: flight.parkedStandIcao, stand: flight.parkedStand })
    .from(flight)
    .where(
      and(
        eq(flight.status, 'completed'),
        isNull(flight.deletedAt),
        isNotNull(flight.aircraftId),
        isNotNull(flight.parkedStand)
      )
    )
    .orderBy(desc(flight.actualInUtc), desc(flight.id))
    .all()
  const latest = new Map<number, AircraftLastParked>()
  for (const row of rows) {
    if (row.aircraftId === null || row.icao === null || row.stand === null || latest.has(row.aircraftId))
      continue
    latest.set(row.aircraftId, { aircraftId: row.aircraftId, icao: row.icao, stand: row.stand })
  }
  return [...latest.values()]
}
