import { and, eq, inArray } from 'drizzle-orm'
import type { NavdataLeg, NavdataProcedureOption, NavdataRunway, ProcedureKind } from '../navdata/navdata-provider'
import { runwayEndsFromCentre } from '../navdata/runway-geometry'
import type { FetchedAirportNavdata } from '../navdata/sim-facilities-fetch'
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
      for (const procedure of procedures) {
        const transitions = procedure.transitionNames.length > 0 ? procedure.transitionNames : [null]
        for (const transition of transitions) {
          const [inserted] = tx
            .insert(navdataProcedure)
            .values({
              icao,
              kind,
              identifier: procedure.name,
              transition,
              runwayIdentsJson: procedure.runwayIdents.length > 0 ? JSON.stringify(procedure.runwayIdents) : null,
              source: 'sim-facility',
              fetchedAt
            })
            .returning()
            .all()
          if (!inserted) continue
          procedure.legs.forEach((leg, seq) => {
            tx.insert(navdataProcedureLeg)
              .values({
                procedureId: inserted.id,
                seq,
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
          })
        }
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
 *  any runway) or whose runway-idents list names the requested runway. */
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
    .map((row) => ({ identifier: row.identifier, transition: row.transition }))
}

export function listCachedProcedureLegs(db: WingLogDb, icao: string, kind: ProcedureKind, identifier: string): NavdataLeg[] {
  const procedure = db
    .select({ id: navdataProcedure.id })
    .from(navdataProcedure)
    .where(and(eq(navdataProcedure.icao, icao), eq(navdataProcedure.kind, kind), eq(navdataProcedure.identifier, identifier)))
    .get()
  if (!procedure) return []
  return db
    .select()
    .from(navdataProcedureLeg)
    .where(eq(navdataProcedureLeg.procedureId, procedure.id))
    .orderBy(navdataProcedureLeg.seq)
    .all()
    .map((row) => ({
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
    }))
}
