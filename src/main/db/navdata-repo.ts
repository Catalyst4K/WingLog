/**
 * The navdata cache: each airport's runways, procedures and their legs, taxi network and stands, as
 * last fetched from the sim. Each kind is replaced wholesale per airport on every fetch, and every
 * lookup reads from here, never from the sim.
 */
import { and, eq, inArray, isNotNull, isNull, min } from 'drizzle-orm'
import type {
  NavdataLeg,
  NavdataProcedureOption,
  NavdataRunway,
  NavdataTaxiSegment,
  ProcedureKind
} from '../navdata/navdata-provider'
import { runwayEndsFromCentre } from '../navdata/runway-geometry'
import { visualApproachRunway } from '@shared/visual-approach'
import { visualApproachLegs, visualApproachOptions } from '../navdata/visual-approach'
import type { NavdataStand } from '@shared/ipc'
import type {
  FetchedAirportNavdata,
  FetchedApproach,
  FetchedProcedure,
  FetchedStand,
  FetchedTaxiNetwork
} from '../navdata/sim-facilities-fetch'
import type { ParsedLeg } from '../sim/facility-fields'
import type { WingLogDb } from './client'
import {
  navdataProcedure,
  navdataProcedureLeg,
  navdataRunway,
  navdataStand,
  navdataTaxiSegment
} from './schema'

/** Replaces every cached row for `icao` with what was just fetched — one transaction, so a
 *  mid-way failure can't leave a stale runway list next to a fresh procedure list. Matches
 *  the "replaced wholesale per airport per fetch" shape the plan chose (no diffing, no
 *  versioning — the sim's own current data is always the source of truth).
 *
 * @param db The database.
 * @param icao The airport.
 * @param fetched Its runways and procedures, as fetched.
 * @param fetchedAt When, as an ISO time.
 */
export function replaceAirportNavdata(
  db: WingLogDb,
  icao: string,
  fetched: FetchedAirportNavdata,
  fetchedAt: string
): void {
  db.transaction((tx) => {
    deleteAirportNavdata(tx, icao)
    insertRunways(tx, icao, fetched.runways, fetchedAt)
    for (const proc of fetched.departures) insertProcedure(tx, icao, 'sid', proc, fetchedAt)
    for (const proc of fetched.arrivals) insertProcedure(tx, icao, 'star', proc, fetchedAt)
    for (const approach of fetched.approaches) insertApproach(tx, icao, approach, fetchedAt)
  })
}

/** A transaction on the WingLog database. */
type Tx = Parameters<Parameters<WingLogDb['transaction']>[0]>[0]

/**
 * Deletes an airport's cached runways, procedures and procedure legs.
 *
 * @param tx The transaction.
 * @param icao The airport.
 */
function deleteAirportNavdata(tx: Tx, icao: string): void {
  const staleProcedureIds = tx
    .select({ id: navdataProcedure.id })
    .from(navdataProcedure)
    .where(eq(navdataProcedure.icao, icao))
    .all()
    .map((row) => row.id)
  if (staleProcedureIds.length > 0) {
    tx.delete(navdataProcedureLeg).where(inArray(navdataProcedureLeg.procedureId, staleProcedureIds)).run()
  }
  tx.delete(navdataProcedure).where(eq(navdataProcedure.icao, icao)).run()
  tx.delete(navdataRunway).where(eq(navdataRunway.icao, icao)).run()
}

/**
 * Stores both ends of each runway, each with its own threshold.
 *
 * @param tx The transaction.
 * @param icao The airport.
 * @param runways The sim's runway records.
 * @param fetchedAt When they were fetched, as an ISO time.
 */
function insertRunways(
  tx: Tx,
  icao: string,
  runways: FetchedAirportNavdata['runways'],
  fetchedAt: string
): void {
  for (const runway of runways) {
    for (const end of runwayEndsFromCentre(runway)) {
      tx.insert(navdataRunway)
        .values({
          icao,
          ident: end.ident,
          headingTrueDeg: end.headingTrueDeg,
          lengthM: end.lengthM,
          widthM: end.widthM,
          surface: end.surface,
          thresholdLat: end.thresholdLat,
          thresholdLon: end.thresholdLon,
          source: 'sim-facility',
          fetchedAt
        })
        .run()
    }
  }
}

/**
 * Stores legs for one procedure, numbering them in the order they're stored. A single
 * incrementing seq across every group is fine: legs are read back filtered by (procedureId,
 * runwayIdent, transitionName), and insertion order within each filtered group is preserved
 * regardless of the counter being shared.
 *
 * @param tx The transaction.
 * @param procedureId The stored procedure.
 * @returns Stores one leg, tagged with its runway transition and enroute or approach transition.
 */
function legInserter(
  tx: Tx,
  procedureId: number
): (leg: ParsedLeg, runwayIdent: string | null, transitionName: string | null) => void {
  let seq = 0
  return (leg, runwayIdent, transitionName) => {
    tx.insert(navdataProcedureLeg)
      .values({
        procedureId,
        runwayIdent,
        transitionName,
        seq: seq++,
        type: leg.type,
        fixIdent: leg.fixIdent,
        fixType: leg.fixType,
        fixLatitude: leg.fixLatitude,
        fixLongitude: leg.fixLongitude,
        turnDirection: leg.turnDirection,
        courseDeg: leg.courseDeg,
        altitude1: leg.altitude1,
        altitude2: leg.altitude2,
        speedLimit: leg.speedLimit,
        routeDistanceM: leg.routeDistanceM
      })
      .run()
  }
}

/**
 * Stores one SID or STAR and its legs: the common legs, then each runway transition's, then each
 * enroute transition's.
 *
 * @param tx The transaction.
 * @param icao The airport.
 * @param kind SID or STAR.
 * @param proc The procedure, as fetched.
 * @param fetchedAt When it was fetched, as an ISO time.
 */
function insertProcedure(
  tx: Tx,
  icao: string,
  kind: 'sid' | 'star',
  proc: FetchedProcedure,
  fetchedAt: string
): void {
  const runwayIdents = proc.runwayTransitions.map((t) => t.runwayIdent)
  const transitionNames = proc.enrouteTransitions.map((t) => t.name)
  const [inserted] = tx
    .insert(navdataProcedure)
    .values({
      icao,
      kind,
      identifier: proc.name,
      runwayIdentsJson: runwayIdents.length > 0 ? JSON.stringify(runwayIdents) : null,
      transitionNamesJson: transitionNames.length > 0 ? JSON.stringify(transitionNames) : null,
      source: 'sim-facility',
      fetchedAt
    })
    .returning()
    .all()
  if (!inserted) return
  const insertLeg = legInserter(tx, inserted.id)
  for (const leg of proc.commonLegs) insertLeg(leg, null, null)
  for (const rt of proc.runwayTransitions) for (const leg of rt.legs) insertLeg(leg, rt.runwayIdent, null)
  for (const et of proc.enrouteTransitions) for (const leg of et.legs) insertLeg(leg, null, et.name)
}

/**
 * Stores one approach and its legs, in the same tables as SIDs and STARs (Finding 3, schema.ts):
 * its final segment as common legs (both tag columns null, like a STAR with no runway
 * transitions), and its APPROACH_TRANSITION legs tagged with transitionName like an
 * ENROUTE_TRANSITION's. runwayIdentsJson is always a single-element array: an approach belongs to
 * exactly one runway.
 *
 * @param tx The transaction.
 * @param icao The airport.
 * @param approach The approach, as fetched.
 * @param fetchedAt When it was fetched, as an ISO time.
 */
function insertApproach(tx: Tx, icao: string, approach: FetchedApproach, fetchedAt: string): void {
  const [inserted] = tx
    .insert(navdataProcedure)
    .values({
      icao,
      kind: 'approach',
      identifier: approach.identifier,
      runwayIdentsJson: JSON.stringify([approach.runwayIdent]),
      transitionNamesJson:
        approach.transitions.length > 0 ? JSON.stringify(approach.transitions.map((t) => t.name)) : null,
      source: 'sim-facility',
      fetchedAt
    })
    .returning()
    .all()
  if (!inserted) return
  const insertLeg = legInserter(tx, inserted.id)
  for (const leg of approach.finalLegs) insertLeg(leg, null, null)
  for (const t of approach.transitions) for (const leg of t.legs) insertLeg(leg, null, t.name)
}

/**
 * Whether an airport's navdata is cached.
 *
 * @param db The database.
 * @param icao The airport.
 * @returns True when it has cached runways.
 */
export function hasCachedAirport(db: WingLogDb, icao: string): boolean {
  const row = db
    .select({ id: navdataRunway.id })
    .from(navdataRunway)
    .where(eq(navdataRunway.icao, icao))
    .get()
  return row !== undefined
}

/** When each part of an airport's cached navdata was fetched; null for a part that isn't cached. */
export interface NavdataFetchTimes {
  /** Runways and procedures, fetched together. */
  airport: string | null
  taxi: string | null
  stands: string | null
}

/**
 * When an airport's cached navdata was last fetched, per part: the oldest row of each, so a part is
 * only as fresh as its stalest row.
 *
 * @param db The database.
 * @param icao The airport.
 * @returns The fetch time of its runways and procedures, taxi network and stands (ISO times).
 */
export function navdataFetchTimes(db: WingLogDb, icao: string): NavdataFetchTimes {
  const runways =
    db
      .select({ at: min(navdataRunway.fetchedAt) })
      .from(navdataRunway)
      .where(eq(navdataRunway.icao, icao))
      .get()?.at ?? null
  const procedures =
    db
      .select({ at: min(navdataProcedure.fetchedAt) })
      .from(navdataProcedure)
      .where(eq(navdataProcedure.icao, icao))
      .get()?.at ?? null
  const taxi =
    db
      .select({ at: min(navdataTaxiSegment.fetchedAt) })
      .from(navdataTaxiSegment)
      .where(eq(navdataTaxiSegment.icao, icao))
      .get()?.at ?? null
  const stands =
    db
      .select({ at: min(navdataStand.fetchedAt) })
      .from(navdataStand)
      .where(eq(navdataStand.icao, icao))
      .get()?.at ?? null
  return {
    airport: [runways, procedures].filter((t): t is string => t !== null).sort()[0] ?? null,
    taxi,
    stands
  }
}

/**
 * An airport's cached runway ends.
 *
 * @param db The database.
 * @param icao The airport.
 * @returns Its runway ends, or none when it isn't cached.
 */
export function listCachedRunways(db: WingLogDb, icao: string): NavdataRunway[] {
  return db
    .select()
    .from(navdataRunway)
    .where(eq(navdataRunway.icao, icao))
    .all()
    .map((row) => ({
      ident: row.ident,
      headingTrueDeg: row.headingTrueDeg,
      lengthM: row.lengthM,
      widthM: row.widthM,
      surface: row.surface,
      thresholdLat: row.thresholdLat,
      thresholdLon: row.thresholdLon
    }))
}

/** `runway`, when given, keeps only procedures with no runway transitions at all (apply to
 *  any runway) or whose runway-idents list names the requested runway. One stored procedure
 *  row can expand into several options here — one per real ENROUTE_TRANSITION name, or a
 *  single `transition: null` option when it has none (the common case so far, see
 *  schema.ts).
 *
 * @param db The database.
 * @param icao The airport.
 * @param kind SID, STAR or approach.
 * @param runway Only this runway's, or null for all.
 * @returns One option per procedure and transition, plus a visual approach per runway end for approaches.
 */
export function listCachedProcedures(
  db: WingLogDb,
  icao: string,
  kind: ProcedureKind,
  runway: string | null
): NavdataProcedureOption[] {
  const rows = db
    .select()
    .from(navdataProcedure)
    .where(and(eq(navdataProcedure.icao, icao), eq(navdataProcedure.kind, kind)))
    .all()
  const real = rows
    .filter((row) => {
      if (!runway || !row.runwayIdentsJson) return true
      const idents = JSON.parse(row.runwayIdentsJson) as string[]
      return idents.includes(runway)
    })
    .flatMap((row) => {
      const transitions: (string | null)[] = row.transitionNamesJson
        ? (JSON.parse(row.transitionNamesJson) as string[])
        : [null]
      return transitions.map((transition) => ({ identifier: row.identifier, transition }))
    })
  // A visual approach is offered for every cached runway alongside the real instrument
  // approaches — only once the airport has any cached navdata at all (no runways, no options).
  return kind === 'approach' ? [...real, ...visualApproachOptions(listCachedRunways(db, icao), runway)] : real
}

/**
 * A database row as a NavdataLeg.
 *
 * @param row The `navdata_procedure_leg` row.
 * @returns The leg.
 */
function toNavdataLeg(row: typeof navdataProcedureLeg.$inferSelect): NavdataLeg {
  return {
    type: row.type,
    fixIdent: row.fixIdent,
    fixType: row.fixType,
    fixLatitude: row.fixLatitude,
    fixLongitude: row.fixLongitude,
    turnDirection: row.turnDirection,
    courseDeg: row.courseDeg,
    altitude1: row.altitude1,
    altitude2: row.altitude2,
    speedLimit: row.speedLimit,
    routeDistanceM: row.routeDistanceM
  }
}

/**
 * The full ordered waypoint list for one (icao, kind, identifier) at a chosen runway/
 * transition. A SID/approach's legs run runway-first (leave the runway, fly the common
 * route, exit via the transition); a STAR's run transition-first (enter via the transition,
 * fly the common route, then the runway-specific final legs) — the reverse order, confirmed
 * live for both kinds (docs/navdata-notes.md). A leg group is only included when its
 * selector is actually supplied — a procedure whose real legs live entirely inside one
 * runway transition (most real SIDs, per docs/navdata-notes.md) returns nothing at all if
 * the caller omits `runway`, rather than guessing which one to use. See schema.ts's
 * navdataProcedureLeg comment for the full ordering rationale.
 *
 * @param db The database.
 * @param icao The airport.
 * @param kind SID, STAR or approach.
 * @param identifier The procedure, e.g. OCEAN2A.
 * @param runway The runway transition, or null.
 * @param transition The enroute or approach transition, or null.
 * @returns The legs in flying order, or none for an unknown procedure.
 */
export function listCachedProcedureLegs(
  db: WingLogDb,
  icao: string,
  kind: ProcedureKind,
  identifier: string,
  runway: string | null = null,
  transition: string | null = null
): NavdataLeg[] {
  if (kind === 'approach') {
    // Synthetic, not in navdata_procedure — built from the runway's own cached threshold.
    const visualRunway = visualApproachRunway(identifier)
    if (visualRunway !== null) {
      const end = listCachedRunways(db, icao).find((r) => r.ident === visualRunway)
      return end ? visualApproachLegs(end) : []
    }
  }
  const procedure = db
    .select({ id: navdataProcedure.id })
    .from(navdataProcedure)
    .where(
      and(
        eq(navdataProcedure.icao, icao),
        eq(navdataProcedure.kind, kind),
        eq(navdataProcedure.identifier, identifier)
      )
    )
    .get()
  if (!procedure) return []

  const runwayLegs = runway
    ? db
        .select()
        .from(navdataProcedureLeg)
        .where(
          and(eq(navdataProcedureLeg.procedureId, procedure.id), eq(navdataProcedureLeg.runwayIdent, runway))
        )
        .orderBy(navdataProcedureLeg.seq)
        .all()
    : []
  const commonLegs = db
    .select()
    .from(navdataProcedureLeg)
    .where(
      and(
        eq(navdataProcedureLeg.procedureId, procedure.id),
        isNull(navdataProcedureLeg.runwayIdent),
        isNull(navdataProcedureLeg.transitionName)
      )
    )
    .orderBy(navdataProcedureLeg.seq)
    .all()
  const transitionLegs = transition
    ? db
        .select()
        .from(navdataProcedureLeg)
        .where(
          and(
            eq(navdataProcedureLeg.procedureId, procedure.id),
            eq(navdataProcedureLeg.transitionName, transition)
          )
        )
        .orderBy(navdataProcedureLeg.seq)
        .all()
    : []

  // ARINC 424 repeats the boundary fix between adjacent groups (the last leg of one is the
  // first leg of the next) — drop the duplicate so the map doesn't get a zero-length segment
  // and a doubled waypoint pin/label. `left`'s last leg and `right`'s first leg are compared;
  // `right` loses its first leg when they match.
  const dedupeBoundary = (left: typeof commonLegs, right: typeof commonLegs): typeof commonLegs => {
    const lastLeft = left[left.length - 1]
    return lastLeft && right[0] && lastLeft.fixIdent === right[0].fixIdent ? right.slice(1) : right
  }

  if (kind === 'approach') {
    // Transition (IAF entry) legs first, then the shared final segment — the reverse of
    // SID/STAR's order, confirmed live 2026-09-08 (docs/navdata-notes.md) to be correct for
    // a real approach.
    return [...transitionLegs, ...dedupeBoundary(transitionLegs, commonLegs)].map(toNavdataLeg)
  }

  if (kind === 'star') {
    // Enter via the enroute transition, fly the shared common route, then the runway
    // transition takes you down to the runway — the reverse of a SID's order. Confirmed
    // live 2026-09-11 (docs/navdata-notes.md) against a real STAR (YBBN SMOK2A) with a
    // non-empty common route: the departure order drew two spurious lines across the
    // arrival, this order doesn't.
    const dedupedCommon = dedupeBoundary(transitionLegs, commonLegs)
    const dedupedRunway = dedupeBoundary(
      dedupedCommon.length > 0 ? dedupedCommon : transitionLegs,
      runwayLegs
    )
    return [...transitionLegs, ...dedupedCommon, ...dedupedRunway].map(toNavdataLeg)
  }

  // SID: leave the runway (runway transition), fly the common route, then exit via the
  // enroute transition. Confirmed live 2026-09-08 (docs/navdata-notes.md).
  const dedupedCommon = dedupeBoundary(runwayLegs, commonLegs)
  const dedupedTransition = dedupeBoundary(
    dedupedCommon.length > 0 ? dedupedCommon : runwayLegs,
    transitionLegs
  )
  return [...runwayLegs, ...dedupedCommon, ...dedupedTransition].map(toNavdataLeg)
}

/** Same "replace wholesale per airport per fetch" shape as replaceAirportNavdata, its own
 *  table — a taxi-network refresh never touches the runway/procedure cache.
 *
 * @param db The database.
 * @param icao The airport.
 * @param fetched Its taxi network, as fetched.
 * @param fetchedAt When, as an ISO time.
 */
export function replaceAirportTaxiSegments(
  db: WingLogDb,
  icao: string,
  fetched: FetchedTaxiNetwork,
  fetchedAt: string
): void {
  db.transaction((tx) => {
    tx.delete(navdataTaxiSegment).where(eq(navdataTaxiSegment.icao, icao)).run()
    for (const segment of fetched.segments) {
      tx.insert(navdataTaxiSegment)
        .values({
          icao,
          startLat: segment.startLat,
          startLon: segment.startLon,
          endLat: segment.endLat,
          endLon: segment.endLon,
          name: segment.name,
          startHoldShort: segment.startHoldShort,
          endHoldShort: segment.endHoldShort,
          source: 'sim-facility',
          fetchedAt
        })
        .run()
    }
  })
}

/**
 * Whether an airport's taxi network is cached.
 *
 * @param db The database.
 * @param icao The airport.
 * @returns True when a network with hold-short points is cached.
 */
export function hasCachedTaxiNetwork(db: WingLogDb, icao: string): boolean {
  // A cache written before hold-short points existed (null flags) counts as missing, so the
  // caller's usual "not cached → fetch" path refreshes it once.
  const row = db
    .select({ id: navdataTaxiSegment.id })
    .from(navdataTaxiSegment)
    .where(and(eq(navdataTaxiSegment.icao, icao), isNotNull(navdataTaxiSegment.startHoldShort)))
    .get()
  return row !== undefined
}

/**
 * An airport's cached taxi network.
 *
 * @param db The database.
 * @param icao The airport.
 * @returns Its taxi segments, or none when it isn't cached.
 */
export function listCachedTaxiSegments(db: WingLogDb, icao: string): NavdataTaxiSegment[] {
  return db
    .select()
    .from(navdataTaxiSegment)
    .where(eq(navdataTaxiSegment.icao, icao))
    .all()
    .map((row) => ({
      startLat: row.startLat,
      startLon: row.startLon,
      endLat: row.endLat,
      endLon: row.endLon,
      name: row.name,
      startHoldShort: row.startHoldShort ?? false,
      endHoldShort: row.endHoldShort ?? false
    }))
}

/**
 * Same wholesale-per-airport replace as the taxi segments, its own table.
 *
 * @param db The database.
 * @param icao The airport.
 * @param stands Its stands, as fetched.
 * @param fetchedAt When, as an ISO time.
 */
export function replaceAirportStands(
  db: WingLogDb,
  icao: string,
  stands: FetchedStand[],
  fetchedAt: string
): void {
  db.transaction((tx) => {
    tx.delete(navdataStand).where(eq(navdataStand.icao, icao)).run()
    for (const s of stands) {
      tx.insert(navdataStand)
        .values({
          icao,
          name: s.name,
          nameCode: s.nameCode,
          number: s.number,
          suffix: s.suffix,
          headingDeg: s.headingDeg,
          lat: s.lat,
          lon: s.lon,
          fetchedAt
        })
        .run()
    }
  })
}

/**
 * An airport's cached stands.
 *
 * @param db The database.
 * @param icao The airport.
 * @returns Its stands, or none when they aren't cached.
 */
export function listCachedStands(db: WingLogDb, icao: string): NavdataStand[] {
  return db
    .select()
    .from(navdataStand)
    .where(eq(navdataStand.icao, icao))
    .all()
    .map((row) => ({
      name: row.name,
      number: row.number,
      suffix: row.suffix,
      headingDeg: row.headingDeg,
      lat: row.lat,
      lon: row.lon
    }))
}
