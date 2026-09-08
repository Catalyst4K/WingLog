/**
 * Typed IPC contract between main and renderer. The renderer only ever calls
 * these — no direct filesystem, network, or SimConnect access (see CLAUDE.md).
 */

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

/** One match from the vendored OurAirports name/ICAO search — see resources/airports.csv. */
export interface AirportOption {
  icao: string
  name: string
  municipality: string | null
  isoCountry: string
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

/** A METAR observation from aviationweather.gov (docs/decisions.md, 2026-09-02). */
export interface MetarReport {
  icao: string
  /** The raw METAR text, e.g. "METAR EGLL 012320Z AUTO 25008KT 9999 NCD 18/12 Q1020". */
  rawText: string
  /** ISO 8601 UTC — empty string if aviationweather.gov didn't report one. */
  observedUtc: string
  flightCategory: 'VFR' | 'MVFR' | 'IFR' | 'LIFR' | null
}

/**
 * Live sim telemetry, in SI units throughout (meters, m/s, kg, degrees) per
 * docs/decisions.md §5 — convert to aviation units only at the UI layer.
 */
export interface SimTelemetry {
  latitude: number
  longitude: number
  altitudeM: number
  altitudeAglM: number
  verticalSpeedMs: number
  indicatedAirspeedMs: number
  trueAirspeedMs: number
  machSpeed: number
  groundSpeedMs: number
  headingTrueDeg: number
  pitchDeg: number
  bankDeg: number
  onGround: boolean
  gForce: number
  fuelTotalKg: number
  totalWeightKg: number
  windSpeedMs: number
  windDirectionDeg: number
  engineCombustion1: boolean
  gearHandlePosition: number
  flapsHandleIndex: number
  parkingBrakeOn: boolean
  atcId: string
  atcModel: string
  title: string
  simRate: number
  slewActive: boolean
}

export type SimConnectionStatus =
  { state: 'disconnected' } | { state: 'connecting' } | { state: 'connected'; simConnectVersion: string }

export type FlightStatus = 'planned' | 'active' | 'completed' | 'abandoned'

/** PLAN.md §1: pushback → taxi → takeoff → climb → cruise → descent → landing → shutdown. */
export type FlightPhase =
  'preflight' | 'pushback' | 'taxi' | 'takeoff' | 'climb' | 'cruise' | 'descent' | 'landing' | 'shutdown'

/**
 * One recorded sample of an active flight. SI units throughout per §5 — convert only at
 * the UI layer. Sparse by design (PLAN.md §5): downsampled to one point per ~15s during
 * cruise, full rate (the sim feed's own 1 Hz) everywhere else.
 */
export interface TrackPoint {
  id: number
  flightId: number
  tsUtc: string
  latitude: number
  longitude: number
  altitudeM: number
  altitudeAglM: number
  indicatedAirspeedMs: number
  machSpeed: number
  groundSpeedMs: number
  verticalSpeedMs: number
  headingTrueDeg: number
  pitchDeg: number
  bankDeg: number
  phase: FlightPhase
  onGround: boolean
  fuelKg: number
  gForce: number
  windSpeedMs: number
  windDirectionDeg: number
}

export type NewTrackPoint = Omit<TrackPoint, 'id'>

/** One flight's touchdown record — see docs/decisions.md's landing-analysis entry.
 *  `runwayIdent`/`distanceFromThresholdM`/`centrelineOffsetM`/`headwindMs`/`crosswindMs`/
 *  `crabDeg` are null when no matching runway end was found (resources/runways.csv has no
 *  entry for the airport, or none within a plausible heading tolerance of the touchdown). */
export interface Landing {
  id: number
  flightId: number
  touchdownTsUtc: string
  verticalSpeedMs: number
  gForce: number
  pitchDeg: number
  bankDeg: number
  headingTrueDeg: number
  indicatedAirspeedMs: number
  groundSpeedMs: number
  windSpeedMs: number
  windDirectionDeg: number
  headwindMs: number | null
  crosswindMs: number | null
  /** Signed angle between the nose and runway centreline at touchdown — see
   *  landing-maths.ts's crabAngleDeg. Positive = nose right of the runway heading. */
  crabDeg: number | null
  runwayIdent: string | null
  distanceFromThresholdM: number | null
  centrelineOffsetM: number | null
  flapSetting: number | null
  /** Always 'derived' for now — see the schema.ts column comment. */
  touchdownSource: 'simvar' | 'derived'
}

/** One row per aircraft-with-a-landing-record, newest first — Fleet's per-aircraft
 *  landing history. */
export interface AircraftLanding extends Landing {
  flightNumber: string | null
  depIcao: string
  arrIcao: string
}

export type LandingSeverity = 'none' | 'firm' | 'hard'

/** Both in feet per minute (the unit pilots actually think in) — converted to/from the
 *  SI-stored touchdown vertical_speed_ms only where a severity is computed
 *  (src/renderer/src/landing-severity.ts), never stored in fpm anywhere else. Defaults
 *  are general-aviation-leaning, not universally correct across a C172-to-A380 fleet —
 *  adjustable in Settings rather than a hardcoded constant. */
export interface LandingThresholds {
  firmFpm: number
  hardFpm: number
}

export interface ActiveTracking {
  flightId: number
  phase: FlightPhase
}

export interface Flight {
  id: number
  aircraftId: number
  status: FlightStatus
  flightNumber: string | null
  depIcao: string
  arrIcao: string
  altnIcao: string | null
  routeString: string | null
  /** Meters — SI internally, converted to feet only at the UI layer (§5). */
  cruiseAltM: number | null
  schedOutUtc: string | null
  schedInUtc: string | null
  actualOutUtc: string | null
  actualOffUtc: string | null
  actualOnUtc: string | null
  actualInUtc: string | null
  blockMinutes: number | null
  airMinutes: number | null
  /** All weights in kg — SI internally, converted to lb only at the UI layer (§5). */
  fuelPlannedKg: number | null
  fuelOutKg: number | null
  fuelInKg: number | null
  fuelBurnKg: number | null
  pax: number | null
  cargoKg: number | null
  zfwKg: number | null
  towKg: number | null
  ldwKg: number | null
  ofpId: string | null
  ofpJson: string | null
  simVersion: string | null
  createdAt: string
  /** The procedures actually chosen — Dispatch's/Track's live selection at whatever moment
   *  it was last written (flight save, or flight completion, whichever is later — see
   *  ProcedureSelection). Null fields mean nothing was ever chosen for that slot, not that
   *  SimBrief's own choice was deliberately kept — this flight predates Phase 5, or nothing
   *  was ever touched. Logbook falls back to the OFP's own SID/STAR when these are all
   *  null (docs/plans/navdata-without-navigraph.md, Phase 5). */
  selectedDepartureRunway: string | null
  selectedSidIdent: string | null
  selectedSidTransition: string | null
  selectedStarIdent: string | null
  selectedStarTransition: string | null
  selectedApproachIdent: string | null
  selectedApproachTransition: string | null
}

/**
 * The live, currently-chosen procedures for a flight — Dispatch and Track both read/write
 * the same lifted state (App.tsx), so switching tabs mid-adjustment never loses or
 * disagrees about what's selected. Every field is independently optional; unlike the old
 * per-field "SimBrief default" sentinel this replaced, there's no separate "use SimBrief's
 * choice" state — a field just holds whatever identifier is actually current, seeded from
 * SimBrief's own choice when an OFP first loads (docs/plans/navdata-without-navigraph.md,
 * Phase 5). `approachIdent`/`approachTransition` have no SimBrief equivalent to seed from —
 * SimBrief never plans an approach — so they start null and get an auto-picked default once
 * real navdata loads (see ProcedureSelector.tsx's auto-default heuristic).
 */
export interface ProcedureSelection {
  departureRunway: string | null
  sidIdent: string | null
  sidTransition: string | null
  starIdent: string | null
  starTransition: string | null
  /** A constructed display identifier ("ILS 07C", "RNP Z 07R") — an approach's runway is
   *  implied by this, there's no separate arrival-runway field any more. */
  approachIdent: string | null
  /** The approach's own entry transition — usually the real fix a STAR hands off at (e.g.
   *  VHHH's "LIMES"), auto-connected from the current STAR's last waypoint when one
   *  matches, but always independently overridable. */
  approachTransition: string | null
}

/** Logbook's summary stats above the flight table — see flight-repo.ts's getLogbookStats.
 *  totalNm is great-circle dep→arr distance (airport-search.ts's getAirportCoords), summed
 *  across every completed flight whose dep/arr airports are both in the vendored airport
 *  list — not the actual flown track, which isn't available for a CSV-imported flight. */
export interface LogbookStats {
  totalFlights: number
  totalBlockMinutes: number
  totalNm: number
}

/** One row per aircraft with at least one completed flight — see flight-repo.ts. */
export interface FleetStats {
  aircraftId: number
  registration: string
  totalHours: number
  totalCycles: number
  lastArrIcao: string
  lastFlightInUtc: string | null
}

export type GsxServiceGroup = 'catering' | 'fuel' | 'handling' | 'passengerBus'

/** A matched GSX ground-service receipt, snapshotted at flight completion rather than
 *  read live — see docs/decisions.md's gsx-invoices entry for why. */
export interface FlightInvoice {
  id: number
  flightId: number
  serviceGroup: GsxServiceGroup
  receiptId: string
  issuedUtc: string
  icao: string
  tail: string
  operator: string | null
  /** USD equivalent GSX computed itself — the only side safe to sum across receipts that
   *  may be in different currencies (docs/gsx-notes.md). Null if the receipt's total
   *  couldn't be parsed. */
  totalUsd: number | null
  /** The original local-currency string, shown verbatim — never reformatted or re-derived. */
  totalText: string | null
  /** Path to the original styled .html receipt — "Open receipt" opens this directly.
   *  May no longer exist if GSX's own admin UI bulk-deleted it; the stored data above
   *  still renders regardless. */
  sourceHtmlPath: string
  /** The full receipt JSON (logoDataUri stripped before storage) — service info rows,
   *  line items, taxes, fx disclosure. Parsed client-side for display. */
  receiptJson: string
}

/** A NOTAIL receipt near a flight's window/airport — not confidently matched (no tail to
 *  compare), so offered for manual attach rather than auto-stored. */
export interface GsxNotailCandidate {
  serviceGroup: GsxServiceGroup
  jsonPath: string
  issuedUtc: string
  icao: string
}

export interface GsxRescanResult {
  invoices: FlightInvoice[]
  notailCandidates: GsxNotailCandidate[]
}

export interface GsxSettings {
  enabled: boolean
  folderPath: string | null
  // ISO 4217 code GSX totals are converted to and displayed in, via a live rate
  // (fxGetRate) — 'USD' means no conversion, matching GSX's own totalUsd field verbatim.
  displayCurrency: string
}

/** Result of the one-time, first-ever-launch check for GSX's expected receipts folder
 *  (flight-test-findings-2026-09-06.md #4) — `found` means the folder existed and GSX was
 *  auto-enabled against it. Only ever returned once, on the launch the check actually
 *  runs; every later launch gets null from the same IPC call. */
export interface GsxFirstLaunchResult {
  found: boolean
}

export interface LogbookImportSkip {
  label: string
  reason: string
}

export interface LogbookImportSummary {
  imported: number
  /** Aircraft auto-created for a registration not already in the fleet — see logbook-import.ts. */
  aircraftCreated: number
  skipped: LogbookImportSkip[]
}

export interface NewFlight {
  aircraftId: number
  status?: FlightStatus
  flightNumber?: string | null
  depIcao: string
  arrIcao: string
  altnIcao?: string | null
  routeString?: string | null
  cruiseAltM?: number | null
  schedOutUtc?: string | null
  schedInUtc?: string | null
  fuelPlannedKg?: number | null
  pax?: number | null
  cargoKg?: number | null
  zfwKg?: number | null
  towKg?: number | null
  ldwKg?: number | null
  ofpId?: string | null
  ofpJson?: string | null
  /** Whatever's currently selected at the moment the flight is saved — the "saved as
   *  planned" write described on ProcedureSelection. Overwritten again at flight
   *  completion if tracking pushes a later selection (TrackingController). */
  selectedDepartureRunway?: string | null
  selectedSidIdent?: string | null
  selectedSidTransition?: string | null
  selectedStarIdent?: string | null
  selectedStarTransition?: string | null
  selectedApproachIdent?: string | null
  selectedApproachTransition?: string | null
}

export interface DispatchWaypoint {
  ident: string
  altitudeFt: number
  distanceNm: number
}

/** A planned mid-cruise altitude increase — see parseStepClimbs in simbrief-client.ts. */
export interface DispatchStepClimb {
  atIdent: string
  toAltitudeFt: number
  /** Unit and value this point was actually coded in on the OFP, e.g. {unit: 'ft',
   *  value: 33000} for FL330, or {unit: 'm', value: 11300} for a Chinese-airspace
   *  metric level like FL1130 — see parseStepClimbs. */
  native: { unit: 'ft' | 'm'; value: number }
}

/** A freshly-fetched OFP, not yet saved as a Flight — the renderer confirms/picks the aircraft first. */
export interface DispatchOfp {
  ofpId: string
  aircraftIcaoType: string
  aircraftRegistration: string
  flightNumber: string
  depIcao: string
  arrIcao: string
  altnIcao: string
  routeString: string
  cruiseAltM: number
  schedOutUtc: string
  schedInUtc: string
  fuelPlannedKg: number
  pax: number
  cargoKg: number
  zfwKg: number
  towKg: number
  ldwKg: number
  /** Plain cost index, no scaling — null if the OFP has none (e.g. a non-CI cruise mode
   *  or a prop aircraft). See docs/simbrief-notes.md — `general.costindex` comes back as
   *  `{}` rather than a string when absent, so this is parsed with a guard, not `num()`. */
  costIndex: number | null
  waypoints: DispatchWaypoint[]
  stepClimbs: DispatchStepClimb[]
  ofpJson: string
  /** Fleet aircraft whose registration matches `aircraftRegistration`, if any. */
  matchedAircraftId: number | null
  /** Which airframe actually generated this OFP (docs/simbrief-notes.md, "aircraft" —
   *  which airframe profile was used). `simbriefInternalId` is only meaningful when
   *  `simbriefIsCustom` is true — for a stock airframe it's just the bare type code,
   *  which is not what `aircraft.simbrief_airframe_id` stores and must never be offered
   *  for auto-capture (see DispatchView's capture-offer logic). */
  simbriefIsCustom: boolean
  simbriefInternalId: string | null
}

/**
 * Display unit for weights app-wide (Fleet and Dispatch both). Storage stays SI (kg)
 * regardless — see §5 — this only controls what the UI shows/accepts. Defaults to 'lb'
 * if never set.
 */
export type WeightUnit = 'kg' | 'lb'

/**
 * Settings' UI page theme (docs/plans/settings-ui-page.md) — 'system' resolves via
 * `window.matchMedia('(prefers-color-scheme: dark)')` and keeps listening, so a user on
 * 'system' sees the app follow an OS appearance change made while it's open. Defaults to
 * 'system' if never set.
 */
export type Theme = 'light' | 'dark' | 'system'

/**
 * Display unit for OFP-derived altitudes (Dispatch's cruise altitude and step climbs).
 * A step climb point is sometimes a metric flight level rather than a standard one (e.g.
 * crossing Chinese airspace) — see parseStepClimbs in simbrief-client.ts for how that's
 * detected and converted to a real feet value. 'ft'/'m' both show every point converted
 * to that one unit; 'hybrid' shows each point in whichever unit it was actually coded
 * in (its `native` field) — feet for a standard level, metres for a metric one — which
 * is how a route crossing into e.g. Chinese airspace actually reads on the OFP itself.
 * Defaults to 'ft' if never set.
 */
export type AltitudeUnit = 'ft' | 'm' | 'hybrid'

/** Display unit for METAR wind speed. Most stations report in knots, but ICAO METARs
 *  outside North America commonly use an `MPS` wind group instead — 'kt' is the default
 *  since knots is the unit most of this app already assumes elsewhere. The raw METAR text
 *  is always shown verbatim regardless of this setting; it only controls a separately
 *  formatted wind line alongside it. */
export type WindSpeedUnit = 'kt' | 'mps'

/** The app's tabs — also the native menu bar's top-level items, see main/menu.ts. */
export type AppPage = 'fleet' | 'dispatch' | 'track' | 'logbook' | 'settings'

/**
 * A departure time to prefill on SimBrief's form, already split into the shape its input
 * parameters want (docs/simbrief-notes.md, 2026-09-02 spike): `date` is midnight UTC of
 * the departure day in epoch seconds, `hour`/`minute` are plain UTC integers.
 * `src/renderer/src/dispatch-time.ts` computes this from a `Date` — a wrong-format date
 * is silently misread by SimBrief (yields a 1970 departure) rather than rejected, so it's
 * computed here, never passed through from free text.
 */
export interface DispatchDeparture {
  dateEpochSeconds: number
  hour: number
  minute: number
}

/**
 * Opens SimBrief's dispatch form pre-filled with a route and airframe. `simbriefAirframeId`
 * takes priority over `icaoType` when set (SimBrief uses the saved custom profile);
 * otherwise SimBrief falls back to its own default airframe for that type — WingLog
 * doesn't need to implement that fallback itself. `airlineIcao`/`flightNumber`/`departure`
 * are optional prefills added on top of the original orig/dest/airframe set (docs/decisions.md,
 * SimBrief-generation entry) — each is only appended to the URL when present, so leaving
 * them unset reproduces the original URL exactly.
 */
export interface DispatchOpenSimBriefParams {
  origIcao: string
  destIcao: string
  icaoType: string
  simbriefAirframeId: string | null
  /** A chosen SimBrief default type (aircraft.simbrief_type) — takes priority over
   *  icaoType for the `type=` fallback when there's no simbriefAirframeId, per
   *  docs/decisions.md's fleet-simbrief-airframe entry. */
  simbriefType?: string | null
  airlineIcao?: string | null
  flightNumber?: string | null
  departure?: DispatchDeparture | null
  /** Advanced options from src/shared/dispatch-options.ts, already reduced to
   *  `[paramName, value]` pairs with unset fields omitted — computed in the renderer
   *  (where it's unit-tested) rather than re-derived here, so this handler stays a plain
   *  pass-through. */
  extra?: [string, string][]
}

/** Cloud sync's runtime status (flightdeck-backend/docs/plans/cloud-sync.md) — polled by
 *  Settings' "Cloud sync" section rather than pushed, since a sync is infrequent and
 *  short (launch + manual "Sync now"), not worth a dedicated push channel for. */
export interface SyncStatus {
  loggedIn: boolean
  email: string | null
  syncing: boolean
  /** ISO 8601 UTC of the last sync that completed without throwing — individual tables
   *  can still have skipped/rejected rows even when this is set; see lastError for
   *  whether the run itself failed outright. */
  lastSyncedAt: string | null
  lastError: string | null
}

/**
 * Navdata (Phase 3, flightdeck-backend's docs/plans/navdata-without-navigraph.md) — real
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
}

export const IpcChannels = {
  aircraftList: 'aircraft:list',
  aircraftCreate: 'aircraft:create',
  aircraftUpdate: 'aircraft:update',
  aircraftDelete: 'aircraft:delete',
  aircraftReplace: 'aircraft:replace',
  aircraftImport: 'aircraft:import',
  aircraftExport: 'aircraft:export',
  simTelemetry: 'sim:telemetry',
  simConnectionStatus: 'sim:connection-status',
  simConnectionStatusGet: 'sim:connection-status:get',
  flightList: 'flight:list',
  flightCreate: 'flight:create',
  dispatchFetchOfp: 'dispatch:fetch-ofp',
  dispatchOpenSimBrief: 'dispatch:open-simbrief',
  dispatchOpenSimBriefAirframes: 'dispatch:open-simbrief-airframes',
  dispatchOpenOfpPdf: 'dispatch:open-ofp-pdf',
  settingsGetSimbriefUsername: 'settings:get-simbrief-username',
  settingsSetSimbriefUsername: 'settings:set-simbrief-username',
  dispatchGenerateOfp: 'dispatch:generate-ofp',
  dispatchLoginSimbrief: 'dispatch:login-simbrief',
  dispatchSimbriefLoginStatus: 'dispatch:simbrief-login-status',
  dispatchLogoutSimbrief: 'dispatch:logout-simbrief',
  dispatchFetchSimbriefUsername: 'dispatch:fetch-simbrief-username',
  dispatchGenerationAvailable: 'dispatch:generation-available',
  settingsGetWeightUnit: 'settings:get-weight-unit',
  settingsSetWeightUnit: 'settings:set-weight-unit',
  settingsGetAltitudeUnit: 'settings:get-altitude-unit',
  settingsSetAltitudeUnit: 'settings:set-altitude-unit',
  settingsGetWindSpeedUnit: 'settings:get-wind-speed-unit',
  settingsSetWindSpeedUnit: 'settings:set-wind-speed-unit',
  settingsGetTheme: 'settings:get-theme',
  settingsSetTheme: 'settings:set-theme',
  trackingStart: 'tracking:start',
  trackingStop: 'tracking:stop',
  trackingFinish: 'tracking:finish',
  trackingGetActive: 'tracking:get-active',
  flightCancel: 'flight:cancel',
  flightDelete: 'flight:delete',
  trackingPoint: 'tracking:point',
  trackPointList: 'track-point:list',
  logbookListCompletedFlights: 'logbook:list-completed-flights',
  logbookGetStats: 'logbook:get-stats',
  logbookFleetStats: 'logbook:fleet-stats',
  logbookImportCsv: 'logbook:import-csv',
  logbookListInvoices: 'logbook:list-invoices',
  settingsGetGsx: 'settings:get-gsx',
  settingsSetGsx: 'settings:set-gsx',
  settingsCheckGsxFirstLaunch: 'settings:check-gsx-first-launch',
  gsxBrowseFolder: 'gsx:browse-folder',
  gsxRescanFlight: 'gsx:rescan-flight',
  gsxAttachNotailReceipt: 'gsx:attach-notail-receipt',
  gsxOpenReceipt: 'gsx:open-receipt',
  logbookOpenOfpPdf: 'logbook:open-ofp-pdf',
  logbookGetLanding: 'logbook:get-landing',
  logbookGreatCircleRoute: 'logbook:great-circle-route',
  fleetListLandings: 'fleet:list-landings',
  fleetListFlights: 'fleet:list-flights',
  settingsGetLandingThresholds: 'settings:get-landing-thresholds',
  settingsSetLandingThresholds: 'settings:set-landing-thresholds',
  aircraftLookupByRegistration: 'aircraft:lookup-by-registration',
  aircraftTypeSearch: 'aircraft:type-search',
  simbriefAirframesForType: 'simbrief:airframes-for-type',
  simbriefCreateCustomAirframe: 'simbrief:create-custom-airframe',
  airportSearch: 'airport:search',
  airlineSearch: 'airline:search',
  airlineFindByIcao: 'airline:find-by-icao',
  weatherGetMetars: 'weather:get-metars',
  fxGetRate: 'fx:get-rate',
  authLogin: 'auth:login',
  authSignup: 'auth:signup',
  authLogout: 'auth:logout',
  syncNow: 'sync:now',
  syncStatus: 'sync:status',
  appGetVersion: 'app:get-version',
  appOpenGithub: 'app:open-github',
  navdataRefreshAirport: 'navdata:refresh-airport',
  navdataHasAirport: 'navdata:has-airport',
  navdataListRunways: 'navdata:list-runways',
  navdataListSids: 'navdata:list-sids',
  navdataListStars: 'navdata:list-stars',
  navdataListApproaches: 'navdata:list-approaches',
  navdataGetProcedureWaypoints: 'navdata:get-procedure-waypoints',
  trackingSetProcedureSelection: 'tracking:set-procedure-selection',
  trackingGetOrphanedFlight: 'tracking:get-orphaned-flight',
  trackingResumeOrphaned: 'tracking:resume-orphaned',
  trackingDiscardOrphaned: 'tracking:discard-orphaned',
  dispatchGetInProgressFlight: 'dispatch:get-in-progress-flight'
} as const

export interface WingLogApi {
  aircraftList: () => Promise<Aircraft[]>
  aircraftCreate: (aircraft: NewAircraft) => Promise<Aircraft>
  aircraftUpdate: (aircraft: AircraftUpdate) => Promise<Aircraft>
  aircraftDelete: (id: number) => Promise<void>
  /**
   * Reassigns every flight from `retiredId` onto `replacementId` and marks `retiredId`
   * retired (docs/plans/aircraft-replacement.md) — for a livery/registration change on an
   * airframe still being flown, not a genuine retirement (which needs no special handling:
   * just stop selecting the old aircraft). Both steps happen in one transaction. Throws if
   * the two ids match, either aircraft doesn't exist, or `retiredId` is already retired.
   */
  aircraftReplace: (retiredId: number, replacementId: number) => Promise<void>
  /** Opens a native file-open dialog in the main process; null if the user cancels. */
  aircraftImport: () => Promise<AircraftImportSummary | null>
  /** Opens a native file-save dialog in the main process; false if the user cancels. */
  aircraftExport: () => Promise<boolean>
  /**
   * Current status, for a renderer mounting after the initial connect already happened —
   * `onSimConnectionStatus` only delivers *future* changes, since Electron doesn't replay
   * missed IPC pushes to a listener that subscribes late.
   */
  getSimConnectionStatus: () => Promise<SimConnectionStatus>
  onSimTelemetry: (listener: (telemetry: SimTelemetry) => void) => () => void
  onSimConnectionStatus: (listener: (status: SimConnectionStatus) => void) => () => void
  flightList: () => Promise<Flight[]>
  /**
   * Creates a new planned flight. Enforces the app's single-flight-in-progress model:
   * abandons any existing planned flight and stops (abandoning) any actively tracked one
   * first, rather than letting flights pile up alongside each other.
   */
  flightCreate: (flight: NewFlight) => Promise<Flight>
  /** Abandons a flight (planned or active) by id — "Cancel flight" before or during tracking. */
  flightCancel: (id: number) => Promise<void>
  /** Permanently deletes a flight and its landing/invoice/track-point rows — a completed
   *  or abandoned flight with bad data, not an in-progress one (use flightCancel for that). */
  flightDelete: (id: number) => Promise<void>
  /** Fetches the SimBrief user's latest OFP. Throws if no username is set or the fetch fails. */
  dispatchFetchOfp: () => Promise<DispatchOfp>
  /** The one flight currently "in progress" (planned or already active — see
   *  getInProgressFlight) reconstructed back into Dispatch's own shape, so Dispatch shows
   *  it again after a restart instead of a blank form — its own `dispatchOfp` is
   *  renderer-only state that doesn't survive one, unlike Track's list, which reads this
   *  same DB state directly and was never the problem. Null if nothing's in progress, or
   *  the in-progress flight has no stored ofpJson (an ad hoc flight started from Track). */
  dispatchGetInProgressFlight: () => Promise<{ flight: Flight; ofp: DispatchOfp } | null>
  /** Opens SimBrief's dispatch page in the default browser, pre-filled where possible. */
  dispatchOpenSimBrief: (params: DispatchOpenSimBriefParams) => Promise<void>
  /** Opens a saved airframe's editor on SimBrief (docs/decisions.md,
   *  fleet-simbrief-airframe entry — `.../airframes/saved/<id-suffix>`), or the plain
   *  saved-airframes list page when `airframeId` is null or has no recognisable suffix. */
  dispatchOpenSimBriefAirframes: (airframeId: string | null) => Promise<void>
  /** Opens a loaded plan's raw OFP PDF straight from the fetched-but-not-yet-flown OFP JSON
   *  (docs/plans/dispatch-action-buttons.md) — a sibling of logbookOpenOfpPdf reusing the
   *  same extractOfpPdfUrl, just fed the renderer's own copy of the JSON instead of looking
   *  a flight row up by id, since a Dispatch plan has no flight row until it's flown. */
  dispatchOpenOfpPdf: (ofpJson: string) => Promise<boolean>
  settingsGetSimbriefUsername: () => Promise<string | null>
  settingsSetSimbriefUsername: (username: string) => Promise<void>
  /**
   * Triggers a real plan generation via SimBrief's keyed API, signed by flightdeck-backend
   * rather than a locally-held key (docs/decisions.md, 2026-09-04) — opens a visible window
   * for SimBrief's own login/generation UI, and resolves with the resulting OFP once it
   * closes. Throws if no username is set, the backend signing request fails, or the window
   * closed without a new plan actually being generated.
   */
  dispatchGenerateOfp: (params: DispatchOpenSimBriefParams) => Promise<DispatchOfp>
  /** Whether generation is possible at all right now — always true, since generation goes
   *  through flightdeck-backend rather than a per-build key. Kept as a channel for a
   *  possible future bring-your-own-key or backend-downtime fallback. */
  dispatchGenerationAvailable: () => Promise<boolean>
  /** Pre-authenticates the generation window's session — persisted across restarts
   *  (docs/decisions.md's SimBrief-login-persistence entry). Purely a convenience;
   *  dispatchGenerateOfp handles its own login inline regardless. */
  dispatchLoginSimbrief: () => Promise<void>
  /** Whether the persisted generation session is logged into SimBrief right now — see
   *  simbrief-generate.ts's isSimbriefLoggedIn. */
  dispatchSimbriefLoginStatus: () => Promise<boolean>
  /** Clears the persisted generation session — see simbrief-generate.ts's
   *  logoutOfSimbrief. */
  dispatchLogoutSimbrief: () => Promise<void>
  /** Reads the logged-in pilot's SimBrief username off their own account page — see
   *  simbrief-generate.ts's fetchSimbriefUsername. Only meaningful once
   *  dispatchSimbriefLoginStatus is true; returns null on anything unexpected rather than
   *  throwing. Settings uses this to offer to fill the username field automatically
   *  instead of requiring it be typed in — the field itself stays editable regardless. */
  dispatchFetchSimbriefUsername: () => Promise<string | null>
  settingsGetWeightUnit: () => Promise<WeightUnit>
  settingsSetWeightUnit: (unit: WeightUnit) => Promise<void>
  settingsGetAltitudeUnit: () => Promise<AltitudeUnit>
  settingsSetAltitudeUnit: (unit: AltitudeUnit) => Promise<void>
  settingsGetWindSpeedUnit: () => Promise<WindSpeedUnit>
  settingsSetWindSpeedUnit: (unit: WindSpeedUnit) => Promise<void>
  settingsGetTheme: () => Promise<Theme>
  settingsSetTheme: (theme: Theme) => Promise<void>
  /** Begins tracking a planned flight. Throws if the sim isn't connected or another flight is already tracked. */
  trackingStart: (flightId: number) => Promise<void>
  /** Cancels tracking mid-flight; marks the flight 'abandoned' rather than 'completed'. */
  trackingStop: () => Promise<void>
  /** Manually completes the actively tracked flight now, rather than waiting for automatic shutdown detection. */
  trackingFinish: () => Promise<void>
  trackingGetActive: () => Promise<ActiveTracking | null>
  trackPointList: (flightId: number) => Promise<TrackPoint[]>
  onTrackingPoint: (listener: (point: TrackPoint) => void) => () => void
  logbookListCompletedFlights: () => Promise<Flight[]>
  logbookGetStats: () => Promise<LogbookStats>
  logbookFleetStats: () => Promise<FleetStats[]>
  /** Opens a native file-open dialog in the main process; null if the user cancels. */
  logbookImportCsv: () => Promise<LogbookImportSummary | null>
  /** Ground-service invoices already stored for a flight (docs/decisions.md,
   *  gsx-invoices entry) — snapshotted at completion, not read live from disk. Empty for
   *  any flight with no matched receipts, which is the normal case. */
  logbookListInvoices: (flightId: number) => Promise<FlightInvoice[]>
  settingsGetGsx: () => Promise<GsxSettings>
  settingsSetGsx: (settings: GsxSettings) => Promise<void>
  /** Call once, on app mount — a no-op (returns null) on every launch after the app's
   *  actual first-ever one, so the caller only ever needs to react to a non-null result. */
  settingsCheckGsxFirstLaunch: () => Promise<GsxFirstLaunchResult | null>
  /** Opens a native folder-picker dialog; null if the user cancels. */
  gsxBrowseFolder: () => Promise<string | null>
  /** Re-scans the configured GSX folder for this flight's receipts and re-stores whatever
   *  matches (replacing any previously stored rows for it) — a no-op returning empty
   *  results when GSX integration is disabled or no folder is set. Needed both for
   *  flights completed before this feature existed and for receipts GSX writes after
   *  block-in. */
  gsxRescanFlight: (flightId: number) => Promise<GsxRescanResult>
  /** Manually attaches one NOTAIL candidate (offered, not auto-matched) to a flight. */
  gsxAttachNotailReceipt: (flightId: number, jsonPath: string) => Promise<FlightInvoice[]>
  /** Opens the original styled .html receipt in the system's default viewer. */
  gsxOpenReceipt: (sourceHtmlPath: string) => Promise<void>
  /** Opens the flight's raw SimBrief OFP PDF in the system's browser/PDF viewer — the URL
   *  is read straight off the flight's already-stored ofpJson (docs/simbrief-notes.md),
   *  no extra fetch. False (not an error) when the flight has no OFP, or its stored JSON
   *  doesn't yield a safe URL to open — e.g. an ad-hoc flight, or an older SimBrief
   *  response shaped differently than expected. */
  logbookOpenOfpPdf: (flightId: number) => Promise<boolean>
  /** The flight's touchdown record, if one was captured — null for any flight tracked
   *  before this feature existed, or one with no landing phase reached (e.g. cancelled
   *  mid-air). */
  logbookGetLanding: (flightId: number) => Promise<Landing | null>
  /** Great-circle fallback route for Logbook's flight-detail map, [lon, lat] pairs (docs/
   *  plans/great-circle-fallback-route.md) — used only when the flight has no OFP-derived
   *  route to draw (parseRouteFromOfpJson came back empty). Null if either ICAO isn't in
   *  the vendored airport list. */
  logbookGreatCircleRoute: (depIcao: string, arrIcao: string) => Promise<[number, number][] | null>
  /** An aircraft's full landing history, newest first — Fleet's per-tail detail page. */
  fleetListLandings: (aircraftId: number) => Promise<AircraftLanding[]>
  /** An aircraft's completed flights, newest first — Fleet's per-tail detail page. Queried
   *  directly rather than filtering flightList() client-side, since that list is already
   *  hundreds of rows on a well-used fleet. */
  fleetListFlights: (aircraftId: number) => Promise<Flight[]>
  settingsGetLandingThresholds: () => Promise<LandingThresholds>
  settingsSetLandingThresholds: (thresholds: LandingThresholds) => Promise<void>
  /** Looks up an aircraft by registration via adsbdb.com. Null if not found (not an error). */
  aircraftLookupByRegistration: (registration: string) => Promise<AircraftLookupResult | null>
  /** Searches the vendored ICAO Doc 8643 type-designator list. Empty for a query under 2 chars. */
  aircraftTypeSearch: (query: string) => Promise<AircraftTypeOption[]>
  /** Fetches SimBrief's live `inputs.airframes.json` and returns every MSFS-platform
   *  saved airframe for this ICAO type, plus the stock default (docs/plans/
   *  simbrief-airframe-picker.md). Empty (not an error) for a type SimBrief doesn't
   *  recognise, or if the fetch itself fails. */
  simbriefAirframesForType: (icaoType: string) => Promise<SimbriefAirframeOption[]>
  /**
   * Opens a real, visible SimBrief share link and waits for the pilot to review and save
   * it into their own account (docs/plans/simbrief-airframe-picker.md's confirmed share →
   * Save flow) — resolves with the resulting `<pilot_id>_<airframe_id>` once observed, or
   * null if the window was closed before a save completed.
   */
  simbriefCreateCustomAirframe: (shareUrl: string) => Promise<string | null>
  /** Searches the vendored OurAirports name/ICAO list. Empty for a query under 2 chars. */
  airportSearch: (query: string) => Promise<AirportOption[]>
  /** Searches the vendored OpenFlights airline list. Empty for a query under 2 chars. */
  airlineSearch: (query: string) => Promise<AirlineOption[]>
  /** Exact ICAO-code lookup against the same vendored airline list — for resolving an
   *  airline already identified by its real ICAO code (e.g. from adsbdb), not a substring
   *  search over a human-typed partial name. undefined if no exact match exists. */
  airlineFindByIcao: (icao: string) => Promise<AirlineOption | undefined>
  /** Looks up current METARs for one or more ICAO codes. An unknown/non-reporting code
   *  is just absent from the result array, not an error. */
  weatherGetMetars: (icaoCodes: string[]) => Promise<MetarReport[]>
  /** USD -> targetCurrency exchange rate for GSX total display, as of `date` (YYYY-MM-DD,
   *  the receipt's issued date) rather than today's rate — omit `date` for the live rate.
   *  null on any lookup failure (unsupported code, network error, future date) — the
   *  caller falls back to USD. */
  fxGetRate: (targetCurrency: string, date?: string) => Promise<number | null>
  /** Cloud sync (flightdeck-backend/docs/plans/cloud-sync.md) — off by default until a
   *  successful login. Throws on invalid credentials or an unreachable backend; a
   *  successful login persists the session (Electron's safeStorage) so it survives a
   *  restart without asking again. */
  authLogin: (email: string, password: string) => Promise<SyncStatus>
  /** Creates a new account, then logs into it — gated behind an invite code checked
   *  server-side (docs/plans/cloud-sync-v2.md); a wrong/missing code fails the same way a
   *  wrong login would, not distinguishably. There is no self-serve public signup yet —
   *  this exists so the one person who has the code doesn't need a separate CLI step. */
  authSignup: (email: string, password: string, inviteCode: string) => Promise<SyncStatus>
  /** "Log out this device" — the stored session is cleared locally regardless of whether
   *  the backend round-trip to invalidate it server-side succeeds. */
  authLogout: () => Promise<SyncStatus>
  /** Triggers one pull-then-push cycle across all synced tables and returns the resulting
   *  status. Throws only if not logged in; a network/server failure during the sync
   *  itself surfaces via the returned status's lastError instead, so a single try/catch
   *  isn't needed at every call site. */
  syncNow: () => Promise<SyncStatus>
  syncStatus: () => Promise<SyncStatus>
  /** The packaged app's version (package.json's, via Electron's app.getVersion()) —
   *  Settings' About card, so a bug report can include which build it's from. */
  appGetVersion: () => Promise<string>
  /** Opens the GitHub repo in the default browser — a fixed URL, not user/third-party
   *  data, but routed through shell.openExternal like every other external link rather
   *  than a raw <a target="_blank"> (which Electron would otherwise open as a new
   *  in-app window, not the system browser). */
  appOpenGithub: () => Promise<void>
  /** Fetches fresh runway/SID/STAR data for `icao` from the sim and replaces the local
   *  cache for it — the write path (call on OFP import, or a manual "Refresh from sim"
   *  control). Throws if the sim isn't reachable or the fetch fails/times out. */
  navdataRefreshAirport: (icao: string) => Promise<void>
  /** True once navdataRefreshAirport has completed for this ICAO at least once — lets the
   *  caller offer "refresh from sim" instead of showing an empty list as if it were final. */
  navdataHasAirport: (icao: string) => Promise<boolean>
  navdataListRunways: (icao: string) => Promise<NavdataRunwayOption[]>
  /** `runway`, when given, filters to procedures that apply to it — a procedure with no
   *  runway transitions registered at all is treated as applying to any runway. */
  navdataListSids: (icao: string, runway?: string | null) => Promise<NavdataProcedureOption[]>
  navdataListStars: (icao: string, runway?: string | null) => Promise<NavdataProcedureOption[]>
  /** `runway`, when given, filters to approaches for that runway — an approach always
   *  belongs to exactly one, unlike a SID/STAR. `identifier` is a constructed display label
   *  ("ILS 07C", "RNP Z 07R"), not a raw NAME — approaches have none of their own. */
  navdataListApproaches: (icao: string, runway?: string | null) => Promise<NavdataProcedureOption[]>
  navdataGetProcedureWaypoints: (
    icao: string,
    kind: NavdataProcedureKind,
    identifier: string,
    runway?: string | null,
    transition?: string | null
  ) => Promise<NavdataLeg[]>
  /** Pushes the current live selection to the main process so it's available whenever the
   *  active flight completes — manual finish *or* automatic shutdown detection, neither of
   *  which round-trips through the renderer (TrackingController). Call on every change
   *  while a flight is actively being tracked; a no-op call with nothing tracked is
   *  harmless (TrackingController just caches it for the flight that starts next). */
  trackingSetProcedureSelection: (selection: ProcedureSelection) => Promise<void>
  /** The flight left 'active' if the app quit or crashed before it reached 'completed' or
   *  'abandoned' — checked once at startup (main/index.ts), so this only ever returns
   *  non-null until the user answers the resume/discard prompt it's meant to drive (or
   *  null immediately, the common case: nothing was orphaned). */
  trackingGetOrphanedFlight: () => Promise<Flight | null>
  /** User chose to resume the orphaned flight above — picks phase detection back up from
   *  where its last persisted track point left off (TrackingController.resume). */
  trackingResumeOrphaned: (flightId: number) => Promise<void>
  /** User chose to discard the orphaned flight above — marks it abandoned rather than
   *  leaving it stuck in 'active' forever. */
  trackingDiscardOrphaned: (flightId: number) => Promise<void>
}
