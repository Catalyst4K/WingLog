import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { NavdataLeg, NavdataProcedureOption, NavdataRunway, ProcedureKind } from '../navdata/navdata-provider'
import { runwayEndsFromCentre } from '../navdata/runway-geometry'
import type { FetchedAirportNavdata } from '../navdata/sim-facilities-fetch'
import type { ParsedLeg } from '../sim/facility-fields'
import type { WingLogDb } from './client'
import { navdataProcedure, navdataProcedureLeg, navdataRunway } from './schema'

/** Replaces every cached row for `icao` with what was just fetched — one transaction, so a
 *  mid-way failure can't leave a stale runway list next to a fresh procedure list. Matches
 *  the "replaced wholesale per airport per fetch" shape the plan chose (no diffing, no
 *  versioning — the sim's own current data is always the source of truth). */
export function replaceAirportNavdata(db: WingLogDb, icao: string, fetched: FetchedAirportNavdata, fetchedAt: string): void {
  db.transaction((tx) => {
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

    for (const runway of fetched.runways) {
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

    for (const [kind, procedures] of [
      ['sid', fetched.departures],
      ['star', fetched.arrivals]
    ] as const) {
      for (const proc of procedures) {
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
        if (!inserted) continue

        // A single incrementing seq across every group is fine — legs are read back
        // filtered by (procedureId, runwayIdent, transitionName), and insertion order
        // within each filtered group is preserved regardless of the counter being shared.
        let seq = 0
        const insertLeg = (leg: ParsedLeg, runwayIdent: string | null, transitionName: string | null): void => {
          tx.insert(navdataProcedureLeg)
            .values({
              procedureId: inserted.id,
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
              speedLimit: leg.speedLimit
            })
            .run()
        }

        for (const leg of proc.commonLegs) insertLeg(leg, null, null)
        for (const rt of proc.runwayTransitions) for (const leg of rt.legs) insertLeg(leg, rt.runwayIdent, null)
        for (const et of proc.enrouteTransitions) for (const leg of et.legs) insertLeg(leg, null, et.name)
      }
    }
  })
}

export function hasCachedAirport(db: WingLogDb, icao: string): boolean {
  const row = db.select({ id: navdataRunway.id }).from(navdataRunway).where(eq(navdataRunway.icao, icao)).get()
  return row !== undefined
}

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
 *  schema.ts). */
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
  return rows
    .filter((row) => {
      if (!runway || !row.runwayIdentsJson) return true
      const idents = JSON.parse(row.runwayIdentsJson) as string[]
      return idents.includes(runway)
    })
    .flatMap((row) => {
      const transitions: (string | null)[] = row.transitionNamesJson ? (JSON.parse(row.transitionNamesJson) as string[]) : [null]
      return transitions.map((transition) => ({ identifier: row.identifier, transition }))
    })
}

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
    speedLimit: row.speedLimit
  }
}

/**
 * The full ordered waypoint list for one (icao, kind, identifier) at a chosen runway/
 * transition — that runway's own legs (if `runway` is given and the procedure has any),
 * then the procedure's common legs, then that transition's own legs (if `transition` is
 * given and the procedure has any). See schema.ts's navdataProcedureLeg comment for what's
 * confirmed about this ordering (a departure, not yet an arrival) and why a leg group is
 * only included when its selector is actually supplied — a procedure whose real legs live
 * entirely inside one runway transition (most real SIDs, per docs/navdata-notes.md) returns
 * nothing at all if the caller omits `runway`, rather than guessing which one to use.
 */
export function listCachedProcedureLegs(
  db: WingLogDb,
  icao: string,
  kind: ProcedureKind,
  identifier: string,
  runway: string | null = null,
  transition: string | null = null
): NavdataLeg[] {
  const procedure = db
    .select({ id: navdataProcedure.id })
    .from(navdataProcedure)
    .where(and(eq(navdataProcedure.icao, icao), eq(navdataProcedure.kind, kind), eq(navdataProcedure.identifier, identifier)))
    .get()
  if (!procedure) return []

  const runwayLegs = runway
    ? db
        .select()
        .from(navdataProcedureLeg)
        .where(and(eq(navdataProcedureLeg.procedureId, procedure.id), eq(navdataProcedureLeg.runwayIdent, runway)))
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
        .where(and(eq(navdataProcedureLeg.procedureId, procedure.id), eq(navdataProcedureLeg.transitionName, transition)))
        .orderBy(navdataProcedureLeg.seq)
        .all()
    : []

  return [...runwayLegs, ...commonLegs, ...transitionLegs].map(toNavdataLeg)
}
