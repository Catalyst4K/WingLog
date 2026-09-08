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

export type ProcedureKind = 'sid' | 'star' | 'approach'

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
  /** `runway`, when given, filters to approaches for that runway — an approach always
   *  belongs to exactly one, unlike a SID/STAR. `identifier` is a constructed display label
   *  (e.g. "ILS 07C", "RNP Z 07R" — see facility-fields.ts's ParsedApproachHeader), since
   *  approaches carry no NAME field of their own. `transition` is the approach's own
   *  APPROACH_TRANSITION name — confirmed live 2026-09-08 (docs/navdata-notes.md) to be the
   *  literal fix ident a STAR hands off at (e.g. VHHH's "LIMES"), the link a caller uses to
   *  auto-connect a chosen STAR onto a chosen approach. */
  listApproaches(icao: string, runway?: string | null): NavdataProcedureOption[]
  /**
   * The full ordered waypoint list for this procedure at a chosen runway/transition —
   * confirmed live (2026-09-08, docs/navdata-notes.md) that a real procedure's legs can
   * live inside a specific runway transition, the procedure's own common list, a specific
   * enroute transition, or some combination, so both selectors matter: omitting `runway`
   * on a procedure whose real legs live entirely inside one runway transition (the common
   * case for a SID) returns nothing, rather than guessing which runway's legs to use.
   * For `kind: 'approach'`, `runway` is ignored (already implied by `identifier`) and the
   * order is transition legs then the shared final segment — the reverse of SID/STAR's
   * runway-then-common-then-transition order, confirmed live the same day to be correct for
   * a real approach (fly the transition inbound, then the shared final segment to the
   * runway) — with the duplicate fix ARINC 424 repeats at that boundary dropped.
   */
  getProcedureWaypoints(icao: string, kind: ProcedureKind, identifier: string, runway?: string | null, transition?: string | null): NavdataLeg[]
}
