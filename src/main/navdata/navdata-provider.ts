/**
 * Navdata provider interface (Phase 3, flightdeck-backend's docs/plans/
 * navdata-without-navigraph.md) — built behind this interface so a future Navigraph
 * provider is a swap, not a rewrite, per that plan's Decision. `SimFacilitiesProvider`
 * (sim-facilities-provider.ts) is the only implementation today.
 */

export interface NavdataRunway {
  ident: string
  headingTrueDeg: number
  lengthM: number
  widthM: number
  /** Raw SimConnect surface-type integer — not yet mapped to a name (facility-fields.ts). */
  surface: number
  thresholdLat: number
  thresholdLon: number
}

export interface NavdataProcedureOption {
  identifier: string
  transition: string | null
}

export interface NavdataLeg {
  type: number
  fixIdent: string | null
  fixType: string | null
  fixLatitude: number
  fixLongitude: number
  turnDirection: number
  courseDeg: number
  altitude1: number
  altitude2: number
  speedLimit: number
}

export type ProcedureKind = 'sid' | 'star'

export interface NavdataProvider {
  /** Fetches fresh navdata for `icao` from the sim and replaces the cache for it — the
   *  write path (called on OFP import, and from a manual "Refresh from sim" control).
   *  Throws if the sim isn't reachable or the fetch fails/times out. */
  refreshAirport(icao: string): Promise<void>
  /** True once at least one refreshAirport(icao) has completed for this ICAO — lets a
   *  caller distinguish "no data yet, offer to refresh" from "refreshed, genuinely empty". */
  hasAirport(icao: string): boolean
  listRunways(icao: string): NavdataRunway[]
  /** `runway`, when given, filters to procedures whose RUNWAY_TRANSITION list names it. A
   *  procedure with no runway transitions registered at all is treated as applying to any
   *  runway, not to none. */
  listSids(icao: string, runway?: string | null): NavdataProcedureOption[]
  listStars(icao: string, runway?: string | null): NavdataProcedureOption[]
  /**
   * The full ordered waypoint list for this procedure at a chosen runway/transition —
   * confirmed live (2026-09-08, docs/navdata-notes.md) that a real procedure's legs can
   * live inside a specific runway transition, the procedure's own common list, a specific
   * enroute transition, or some combination, so both selectors matter: omitting `runway`
   * on a procedure whose real legs live entirely inside one runway transition (the common
   * case for a SID) returns nothing, rather than guessing which runway's legs to use.
   */
  getProcedureWaypoints(icao: string, kind: ProcedureKind, identifier: string, runway?: string | null, transition?: string | null): NavdataLeg[]
}
