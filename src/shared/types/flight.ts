/** Flights, their tracks and the logbook: what tracking records and the Logbook shows. */

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
  /** Null for any point recorded before this column existed (logbook-detail-improvements.md
   *  Phase 3) — existing rows stay null forever, nothing backfills them. A non-null value
   *  is always real going forward: FlightRecorder always supplies SimTelemetry's own
   *  pressureAltitudeM, which SimConnect always returns once requested. */
  pressureAltitudeM: number | null
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
  /** Incremented each time TrackingController.resume() picks a flight back up after the
   *  app/process restarted mid-flight — see winglog-backend's docs/plans/done/
   *  resume-track-cleanup.md. 0 for a flight never resumed. The map draws one line per
   *  segment and never joins across a boundary, so a restart's spawn-point/teleport-back
   *  artefacts can't be drawn as a straight line across the gap even before any cleanup
   *  logic runs. */
  resumeSegment: number
  /** Sim time compression at the moment this point was recorded — needed to tell a
   *  legitimate high-speed-over-ground-at-4x sample apart from a physically impossible
   *  teleport (winglog-backend's docs/plans/done/resume-track-cleanup.md). */
  simRate: number
  /** Set by the post-resume cleanup pass, never at record time — see the plan doc above.
   *  Null means this point is genuine and should be shown; every consumer (the map, route
   *  simplification, future stats) filters on this being null rather than deleting rows,
   *  so the raw samples stay available for re-running the cleanup after a threshold
   *  change. */
  excludedReason: 'resume-spurious' | 'resume-superseded' | null
}

export type NewTrackPoint = Omit<TrackPoint, 'id'>

/** Result of an on-demand resume-cleanup pass (the Logbook "Clean up track" button,
 *  winglog-backend's docs/plans/done/resume-track-cleanup.md) — a manual trigger for a
 *  flight that already completed, alongside the automatic live/completion-time pass
 *  TrackingController already runs. Both `excludedCount`/`resegmentedCount` are 0 when
 *  nothing needed fixing. */
export interface TrackCleanupSummary {
  excludedCount: number
  resegmentedCount: number
}

export interface ActiveTracking {
  flightId: number
  phase: FlightPhase
}

/**
 * The confirmed fields from free-flight-tracking.md's "Start a free flight" dialog —
 * everything the dialog resolved/let the pilot edit, ready to create the flight and start
 * tracking it directly at 'active' with no earlier 'planned' stage. `null` for depIcao/
 * arrIcao means the dialog had nothing to prefill and the pilot left it blank — main
 * resolves that to 'ZZZZ' (ICAO's own "no location indicator assigned" code) rather than
 * leaving either column null, matching the plan's schema-migration-avoidance reasoning.
 */
export interface StartFreeFlightInput {
  /** Null when the pilot chose not to add this aircraft to the fleet at all — see
   *  simRegistration/simIcaoType below, which carry its identity instead in that case. */
  aircraftId: number | null
  /** Required together with a null aircraftId; ignored (should be null) otherwise. */
  simRegistration: string | null
  simIcaoType: string | null
  depIcao: string | null
  arrIcao: string | null
  flightNumber: string | null
}

/**
 * Everything the "Start a free flight" dialog needs to prefill itself, resolved in main
 * from the live telemetry the renderer already has (free-flight-tracking.md's
 * aircraft-resolution table). See free-flight.ts's getFreeFlightPrefill for the composition.
 */
export interface FreeFlightPrefill {
  registration: string
  icaoType: string | null
  icaoTypeAmbiguous: boolean
  suggestedDepIcao: string | null
  rememberedAircraftId: number | null
}

/** A Logbook list row: a completed `Flight` without its raw SimBrief OFP text. That text is
 *  ~90 KB per flight and the list only ever needed to know whether one exists — sending it
 *  made the Logbook copy ~16 MB on every open (real measurement, 173 flights, 2026-10-01).
 *  Anything needing the OFP itself fetches it per flight by id. */
export type LogbookFlight = Omit<Flight, 'ofpJson'> & { hasOfp: boolean }

export interface Flight {
  id: number
  /** Null for a free flight tracked without adding an aircraft to the fleet — see
   *  simRegistration/simIcaoType, which carry its identity in that case instead. */
  aircraftId: number | null
  /** Set only when aircraftId is null — the sim-reported registration/type at free-flight
   *  start (free-flight-tracking.md's "don't add to fleet" option), kept for display since
   *  there's no linked aircraft record to read it from otherwise. */
  simRegistration: string | null
  simIcaoType: string | null
  /** The raw sim `title` at free-flight start, set only alongside the two fields above —
   *  powers a retroactive title -> aircraft memory when "Add to fleet" happens later from
   *  Logbook (flightLinkAircraft) instead of inline in the start dialog. */
  simTitle: string | null
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
  /** The airport the selected STAR/approach are for — the alternate when the pilot switched the
   *  Procedures dialog to it; null = the filed destination. */
  selectedArrivalIcao: string | null
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
  /** Which airport the STAR/approach dropdowns are for: `null` = the filed destination, or the
   *  alternate's ICAO when the pilot switched to it for a diversion (v1.1.1). */
  arrivalIcao: string | null
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

export interface LogbookImportSkip {
  label: string
  reason: string
}

/** File format for Settings → Data's Fleet/Logbook import and export. */
export type DataFormat = 'csv' | 'json'

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
  selectedArrivalIcao?: string | null
}

/** One interval the sim was paused, wall-clock ISO timestamps — see completeFlight's own
 *  comment for why this needs to exist at all. */
export interface PausedInterval {
  startIso: string
  endIso: string
}

/** A flight started with no SimBrief plan (free-flight tracking), as stored. */
export interface NewFreeFlightInput {
  /** Null when the pilot chose not to add this aircraft to the fleet — simRegistration/
   *  simIcaoType are then required instead, carrying its identity on the flight row itself. */
  aircraftId: number | null
  simRegistration?: string | null
  simIcaoType?: string | null
  /** The raw sim `title` at free-flight start — only meaningful alongside a null aircraftId,
   *  same convention as simRegistration/simIcaoType. Lets a later Logbook "Add to fleet"
   *  (linkAircraftToFlight) seed the title -> aircraft memory retroactively. */
  simTitle?: string | null
  depIcao: string
  arrIcao: string
  flightNumber: string | null
  fuelOutKg: number
  simVersion?: string
}

/** A flight's dev-build capture: none, kept automatically (newest 50), or kept for good. */
export type CaptureKeepState = 'none' | 'auto' | 'kept'
