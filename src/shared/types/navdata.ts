/** Airport navdata from the sim: runways, procedures, stands and taxiways. */

/**
 * Navdata (Phase 3, winglog-backend's docs/plans/navdata-without-navigraph.md) — real
 * runway/SID/STAR data from MSFS's own SimConnect Facilities API, cached locally per
 * airport. `refresh` is the only channel that touches the sim; the rest read the cache, so
 * a Dispatch dropdown doesn't wait on a live SimConnect round-trip on every keystroke.
 */
export interface NavdataRunwayOption {
  ident: string
  headingTrueDeg: number
  lengthM: number
  widthM: number
  /** Raw SimConnect surface-type integer — not yet mapped to a name. */
  surface: number
  thresholdLat: number
  thresholdLon: number
}

/** One selectable SID/STAR + transition combination — `transition` is null for "no
 *  transition" (a procedure with none defined, or the direct-to-common-point option). */
export interface NavdataProcedureOption {
  identifier: string
  transition: string | null
}

export type NavdataProcedureKind = 'sid' | 'star' | 'approach'

/** One leg of a procedure's own common leg list — not yet split by transition, see
 *  flightdeck's src/main/sim/facility-fields.ts for why. */
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
  /** Metres along `courseDeg` from `fixIdent` — FC/FD legs only, 0 otherwise. */
  routeDistanceM: number
}

/** A stand/gate from the sim (TAXI_PARKING) — see main's sim-facilities-fetch.ts fetchStands. */
export interface NavdataStand {
  /** As ATC says it: "N32", "79". */
  name: string
  number: number
  /** Non-zero on a twin entry for the same name (likely a MARS stand's halves). */
  suffix: number
  headingDeg: number
  lat: number
  lon: number
}

/** One runway end from the sim's navdata cache (`navdata_runway`). */
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

/** One taxiway-network segment (a single TAXI_PATH record, resolved to real lat/lon
 *  endpoints) — the full set for an airport is a basic taxi chart, not a specific route.
 *  `name` is the taxiway identifier (e.g. "C", "W1"), or null for an unnamed segment. */
export interface NavdataTaxiSegment {
  startLat: number
  startLon: number
  endLat: number
  endLon: number
  name: string | null
  /** Whether each endpoint is a hold-short point (TAXI_POINT TYPE 2/4/5/6 — SDK enum; 5 seen
   *  live at VHHH, 2026-09-30). Lets a traced taxi route stop exactly at a named holding
   *  point (winglog-backend's docs/beyondatc-notes.md). */
  startHoldShort: boolean
  endHoldShort: boolean
}
