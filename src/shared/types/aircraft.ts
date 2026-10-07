/** Fleet aircraft, and the reference lists the Fleet forms search (types, airframes, airlines). */

/**
 * Identity + linkage only (docs/decisions.md, 2026-09-01 Fleet-simplification entry) —
 * performance data lives in the linked SimBrief profile, not here. Hours/cycles are
 * computed live from flight history, see FleetStats below.
 */
export interface Aircraft {
  id: number
  registration: string
  icaoType: string
  /** Airline/operator, shown as "Airline" in the UI. */
  operator: string | null
  /** IATA code of the operator, if picked from the airline search — used to fetch a
   *  logo (docs/decisions.md, 2026-09-01 airline-search entry). Null for an operator
   *  typed free-hand or filled in from a registration lookup, which has no code. */
  operatorIata: string | null
  /** ICAO code of the operator — what SimBrief's `airline` generation parameter and a
   *  real-world callsign use. Doesn't derive from operatorIata or vice versa, so both
   *  are stored independently when picked from the airline search. */
  operatorIcao: string | null
  /** SimBrief saved-airframe internal ID, shown as "SimBrief profile" in the UI. */
  simbriefAirframeId: string | null
  /** A chosen SimBrief *default* type, distinct from a saved custom profile — see
   *  schema.ts. Null means "use icaoType as SimBrief's type parameter", same as before
   *  this field existed. */
  simbriefType: string | null
  /** Denormalized label for whichever of simbriefAirframeId/simbriefType is currently set,
   *  snapshotted when the community-airframe picker (docs/plans/simbrief-airframe-picker.md)
   *  set it — null for a manually-typed id/type, or when nothing's set, in which case the
   *  UI falls back to showing the plain id/type. All three travel together. */
  simbriefAirframeDeveloper: string | null
  simbriefAirframeEngines: string | null
  simbriefAirframeRegistration: string | null
  currentIcao: string | null
  createdAt: string
  /** Set once this aircraft has been replaced by another (docs/plans/aircraft-replacement.md)
   *  — the id of the aircraft its flight history now lives under. Null means active/
   *  selectable; anywhere an aircraft is picked (Dispatch's aircraft select, "new flight"
   *  flows) should filter these out — a retired aircraft has no flights of its own left. */
  replacedByAircraftId: number | null
  /** ISO 8601 UTC of a plain Retire (docs/plans/fleet-retire.md) — flights stay on this
   *  aircraft, unlike a replace. Use `isRetired` (shared/aircraft.ts), not this alone. */
  retiredAt: string | null
  /** Real-world livery photo thumbnail from adsbdb's registration lookup — see
   *  schema.ts's photoThumbnailUrl comment. Null for a fictional/GA registration adsbdb
   *  has no photo for, or one never looked up. */
  photoThumbnailUrl: string | null
}

export interface NewAircraft {
  registration: string
  icaoType: string
  operator?: string | null
  operatorIata?: string | null
  operatorIcao?: string | null
  simbriefAirframeId?: string | null
  simbriefType?: string | null
  simbriefAirframeDeveloper?: string | null
  simbriefAirframeEngines?: string | null
  simbriefAirframeRegistration?: string | null
  currentIcao?: string | null
  photoThumbnailUrl?: string | null
}

export interface AircraftUpdate extends NewAircraft {
  id: number
}

export interface AircraftImportSkip {
  registration: string
  reason: string
}

export interface AircraftImportSummary {
  imported: number
  skipped: AircraftImportSkip[]
}

/** Result of a registration lookup (docs/decisions.md, adsbdb) — null means not found. */
export interface AircraftLookupResult {
  icaoType: string
  operator: string | null
  /** The operator's ICAO code (adsbdb's "operator flag code") — used to resolve the
   *  exact vendored airline entry (and its IATA code, for a logo) rather than fuzzy-
   *  matching adsbdb's free-text operator name against it. Null if adsbdb didn't have
   *  one for this aircraft. */
  operatorIcao: string | null
  /** adsbdb's `url_photo_thumbnail` — see Aircraft.photoThumbnailUrl. Deliberately not
   *  `url_photo` (full-size): confirmed live it 404s consistently, see docs/decisions.md,
   *  2026-09-07. Null if adsbdb had no photo for this registration. */
  photoThumbnailUrl: string | null
}

/** One match from the vendored ICAO Doc 8643 type-designator list (see resources/). */
export interface AircraftTypeOption {
  manufacturer: string
  model: string
  icaoType: string
  wakeCat: string
}

/**
 * One saved airframe from SimBrief's own live `inputs.airframes.json` feed for a given
 * ICAO type (docs/plans/simbrief-airframe-picker.md) — never vendored/stored, fetched
 * fresh each time the picker opens. `isDefault` is SimBrief's own stock profile for the
 * type (nothing to share/create — picking it just clears both simbrief_* fields).
 * `developer`/`platform` are parsed from SimBrief's free-text `airframe_comments` (already
 * filtered server-side to `platform === 'MSFS'` plus the stock default, so the renderer
 * never sees an X-Plane/P3D entry) — null when the comment doesn't match the usual
 * "Developer (Platform) - variant" shape, in which case `comments` is the only label.
 */
export interface SimbriefAirframeOption {
  isDefault: boolean
  developer: string | null
  /** Whatever in `airframe_comments` distinguishes this entry from another with the same
   *  developer/engines — e.g. "(SL)" vs "(WF)" on an A320, or a whole descriptive phrase
   *  like "Dual Class" on a PMDG 737 (docs/simbrief-notes.md, 2026-09-08 entry). Null when
   *  there's nothing beyond developer/engines to show, or the comment didn't parse at all. */
  variant: string | null
  engines: string
  /** Raw `airframe_comments` — always present, the guaranteed fallback label. */
  comments: string
  registration: string | null
  /** SimBrief's own type code for this entry's parent group (e.g. "A20N") — what gets
   *  written to aircraft.simbrief_type when this option is picked. */
  simbriefType: string
  /** Only present for a community (non-default) entry — SimBrief's own "Share Airframe"
   *  link for it (docs/plans/simbrief-airframe-picker.md's confirmed share → Save flow). */
  shareUrl: string | null
}

/** One match from the vendored OpenFlights airline database (see resources/airlines.csv). */
export interface AirlineOption {
  name: string
  icao: string
  /** IATA code — empty string if the airline has none (some cargo/charter carriers don't). */
  iata: string
}

/** Where a fleet aircraft last parked (its latest completed flight that recorded a stand). */
export interface AircraftLastParked {
  aircraftId: number
  icao: string
  stand: string
}
