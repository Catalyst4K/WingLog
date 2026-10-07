/**
 * Typed IPC contract between main and renderer. The renderer only ever calls
 * these — no direct filesystem, network, or SimConnect access (see CLAUDE.md).
 *
 * This file holds the contract itself, `WingLogApi`. The types it carries live by area in
 * `types/`, and the channel names in `ipc-channels.ts`; both are re-exported here, so
 * `@shared/ipc` stays the one import for all of it.
 */

import type {
  Aircraft,
  AircraftImportSummary,
  AircraftLastParked,
  AircraftLookupResult,
  AircraftTypeOption,
  AircraftUpdate,
  AirlineOption,
  NewAircraft,
  SimbriefAirframeOption
} from './types/aircraft'
import type { Airfield, AirportOption, MetarReport } from './types/airports'
import type {
  BeyondAtcArrivalClearance,
  BeyondAtcConnectionStatus,
  BeyondAtcSettings,
  BeyondAtcState,
  BeyondAtcStepClimbStatus,
  BeyondAtcTranscriptEntry
} from './types/beyondatc'
import type { DispatchOfp, DispatchOpenSimBriefParams } from './types/dispatch'
import type {
  ActiveTracking,
  CaptureKeepState,
  DataFormat,
  FleetStats,
  Flight,
  FreeFlightPrefill,
  LogbookFlight,
  LogbookImportSummary,
  LogbookStats,
  NewFlight,
  ProcedureSelection,
  StartFreeFlightInput,
  TrackCleanupSummary,
  TrackPoint
} from './types/flight'
import type {
  FlightInvoice,
  GsxFirstLaunchResult,
  GsxRemoteCommandBar,
  GsxRemoteCommandId,
  GsxRemoteConnectionStatus,
  GsxRemoteGateInfo,
  GsxRemoteMenuState,
  GsxRemotePromptState,
  GsxRemoteServiceStatus,
  GsxRemoteSettings,
  GsxRescanResult,
  GsxSettings
} from './types/gsx'
import type {
  AircraftLanding,
  LandingListRow,
  LandingScoreSummary,
  LandingWithDetails
} from './types/landing'
import type {
  NavdataLeg,
  NavdataProcedureKind,
  NavdataProcedureOption,
  NavdataRunwayOption,
  NavdataStand,
  NavdataTaxiSegment
} from './types/navdata'
import type {
  AltitudeUnit,
  AppLanguage,
  LandingDistanceUnit,
  MapLanguage,
  SetupContext,
  SetupState,
  SyncStatus,
  Theme,
  TrackingSettings,
  UpdateSettings,
  UpdateStatus,
  WeightUnit,
  WindSpeedUnit
} from './types/settings'
import type { SimConnectionStatus, SimTelemetry } from './types/sim'

export type * from './types/aircraft'
export type * from './types/airports'
export type * from './types/sim'
export type * from './types/flight'
export type * from './types/landing'
export type * from './types/gsx'
export type * from './types/beyondatc'
export type * from './types/settings'
export type * from './types/dispatch'
export type * from './types/navdata'
export { IpcChannels } from './ipc-channels'

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
  /** Retires an aircraft *without* moving its flights (docs/plans/fleet-retire.md). Throws if
   *  it doesn't exist or is already retired (retired or replaced). */
  aircraftRetire: (id: number) => Promise<void>
  /** Reverses aircraftRetire. Throws unless the aircraft was plainly retired — a *replaced*
   *  aircraft can't be un-retired, its flights already live on the replacement. */
  aircraftUnretire: (id: number) => Promise<void>
  /** Opens a native file-open dialog in the main process; null if the user cancels. */
  aircraftImport: (format?: DataFormat) => Promise<AircraftImportSummary | null>
  /** Opens a native file-save dialog in the main process; false if the user cancels. */
  aircraftExport: (format?: DataFormat) => Promise<boolean>
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
  /** Links a fleet aircraft (existing or just created via aircraftCreate) to a completed
   *  free flight that was tracked with no aircraft at all — Logbook's post-flight "Add to
   *  fleet" flow, replacing the fleet-creation option that used to live inline in the start
   *  dialog. Nulls the flight's simRegistration/simIcaoType/simTitle, backfills the
   *  aircraft's currentIcao from the flight's arrival, and remembers the title -> aircraft
   *  mapping for next time. Throws if the flight already has a linked aircraft or the
   *  aircraft is retired/missing. */
  flightLinkAircraft: (flightId: number, aircraftId: number) => Promise<Flight>
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
   * Triggers a real plan generation via SimBrief's keyed API, signed by winglog-backend
   * rather than a locally-held key (docs/decisions.md, 2026-09-04) — opens a visible window
   * for SimBrief's own login/generation UI, and resolves with the resulting OFP once it
   * closes. Throws if no username is set, the backend signing request fails, or the window
   * closed without a new plan actually being generated.
   */
  dispatchGenerateOfp: (params: DispatchOpenSimBriefParams) => Promise<DispatchOfp>
  /** Whether generation is possible at all right now — always true, since generation goes
   *  through winglog-backend rather than a per-build key. Kept as a channel for a
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
  settingsGetMapLanguage: () => Promise<MapLanguage>
  settingsSetMapLanguage: (language: MapLanguage) => Promise<void>
  settingsGetAppLanguage: () => Promise<AppLanguage>
  settingsSetAppLanguage: (language: AppLanguage) => Promise<void>
  /** The OS's own locale (Electron's `app.getLocale()`) — used to resolve AppLanguage's
   *  'system' value to an actual supported language client-side (app-language.ts's
   *  resolveAppLanguage). Not itself a setting; nothing persists it. */
  settingsGetSystemLocale: () => Promise<string>
  settingsGetWindSpeedUnit: () => Promise<WindSpeedUnit>
  settingsSetWindSpeedUnit: (unit: WindSpeedUnit) => Promise<void>
  settingsGetLandingDistanceUnit: () => Promise<LandingDistanceUnit>
  settingsSetLandingDistanceUnit: (unit: LandingDistanceUnit) => Promise<void>
  settingsGetTheme: () => Promise<Theme>
  settingsSetTheme: (theme: Theme) => Promise<void>
  /** Begins tracking a planned flight. Throws if the sim isn't connected or another flight is already tracked. */
  trackingStart: (flightId: number) => Promise<void>
  /** Creates and starts tracking a free flight (free-flight-tracking.md) — no planned
   *  stage, no filed OFP, seeded from whatever the sim is already doing (mid-air included).
   *  Resolves to the new flight's id. Same throw conditions as trackingStart. */
  trackingStartFree: (input: StartFreeFlightInput) => Promise<number>
  /** Resolves the "Start a free flight" dialog's prefill from the current sim telemetry —
   *  call once when the dialog opens, not on every telemetry tick. */
  trackingGetFreeFlightPrefill: (input: {
    atcId: string
    atcModel: string
    title: string
    latitude: number
    longitude: number
  }) => Promise<FreeFlightPrefill>
  /** Cancels tracking mid-flight — deletes the flight (and any track points it recorded)
   *  rather than saving it as 'completed'. */
  trackingStop: () => Promise<void>
  /** Manually completes the actively tracked flight now, rather than waiting for automatic shutdown detection. */
  trackingFinish: () => Promise<void>
  trackingGetActive: () => Promise<ActiveTracking | null>
  trackPointList: (flightId: number) => Promise<TrackPoint[]>
  onTrackingPoint: (listener: (point: TrackPoint) => void) => () => void
  /** Pushed whenever a resume-cleanup pass (winglog-backend's docs/plans/done/
   *  resume-track-cleanup.md) changes an already-recorded point — newly excluded, or
   *  retagged with a new resumeSegment — carrying each affected point at its now-current
   *  value so a live map already showing the earlier copy (from onTrackingPoint) can patch
   *  it in place. */
  onTrackingPointsUpdated: (listener: (points: TrackPoint[]) => void) => () => void
  /** Manually re-runs the resume-cleanup pass for one already-completed flight — the
   *  Logbook detail page's "Clean up track" button, alongside the automatic live/
   *  completion-time pass TrackingController already runs on its own. Useful for a flight
   *  completed before Phase 2 existed, or on the rare chance the live check missed
   *  something. A no-op (both counts 0) when there's nothing to clean up. */
  trackPointCleanup: (flightId: number) => Promise<TrackCleanupSummary>
  logbookListCompletedFlights: () => Promise<LogbookFlight[]>
  /** One flight in full, OFP included — the detail view's own fetch, so the list doesn't
   *  have to carry every flight's OFP. Null for an unknown or deleted id. */
  logbookGetFlight: (id: number) => Promise<Flight | null>
  logbookGetStats: () => Promise<LogbookStats>
  logbookFleetStats: () => Promise<FleetStats[]>
  /** Opens a native file-open dialog in the main process; null if the user cancels. */
  /** Imports SimToolkitPro's CSV *or* WingLog's own CSV export (told apart by header). */
  logbookImportCsv: () => Promise<LogbookImportSummary | null>
  /** Imports WingLog's own JSON export. Native file-open dialog; null if cancelled. */
  logbookImportJson: () => Promise<LogbookImportSummary | null>
  /** Summary export of every completed flight (not a backup — no OFP/track points). Native
   *  file-save dialog; false if cancelled. */
  logbookExport: (format: DataFormat) => Promise<boolean>
  /** Ground-service invoices already stored for a flight (docs/decisions.md,
   *  gsx-invoices entry) — snapshotted at completion, not read live from disk. Empty for
   *  any flight with no matched receipts, which is the normal case. */
  logbookListInvoices: (flightId: number) => Promise<FlightInvoice[]>
  settingsGetTracking: () => Promise<TrackingSettings>
  settingsSetTracking: (settings: TrackingSettings) => Promise<void>
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
  /** Every touchdown recorded for a flight, in touchdown order, each with its runway
   *  geometry and score already resolved (winglog-backend's docs/plans/
   *  multiple-landings.md) — replaces the old logbookGetLanding/-Runway/-Score trio with
   *  one call. Empty for any flight tracked before landing capture existed, or with no
   *  landing phase reached (e.g. cancelled mid-air). */
  logbookListLandings: (flightId: number) => Promise<LandingWithDetails[]>
  /** Every touchdown across every non-deleted flight, newest first — the Logbook Landings
   *  sub-tab (winglog-backend's docs/plans/multiple-landings.md Phase 3). */
  logbookListAllLandings: () => Promise<LandingListRow[]>
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
  /** Every completed flight's landing score, for Logbook's list-view column — omits any
   *  flight with no landing row, which the list shows as "—" for (see LandingScoreSummary). */
  logbookListFlightScores: () => Promise<LandingScoreSummary[]>
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
  /** Every airfield with a position (~43k, from the same vendored list) — for the Track
   *  map's VFR overlay. Loaded on demand, only when that overlay is first switched on. */
  airportListAirfields: () => Promise<Airfield[]>
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
  /** Cloud sync (winglog-backend/docs/plans/cloud-sync.md) — off by default until a
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
  /** Writes a renderer failure to main.log as a warning: what was being done, and the error's
   *  message. The renderer has no log of its own (coding-standards.md §6). */
  appLogRendererError: (context: string, message: string) => Promise<void>
  /** Dev build only: one line to `diag.log` (category 'map', etc.). Does nothing in a normal
   *  build; validated in main like every other channel. */
  diagLog: (category: string, message: string) => Promise<void>
  /** Dev build only: whether a flight has a full capture, and whether it's kept for good
   *  ('none' in a normal build). */
  captureKeepState: (flightId: number) => Promise<CaptureKeepState>
  /** Dev build only: keeps a flight's capture for good (moves it into `captures/kept/`). */
  captureKeep: (flightId: number) => Promise<CaptureKeepState>
  /** Opens the GitHub repo in the default browser — a fixed URL, not user/third-party
   *  data, but routed through shell.openExternal like every other external link rather
   *  than a raw <a target="_blank"> (which Electron would otherwise open as a new
   *  in-app window, not the system browser). */
  appOpenGithub: () => Promise<void>
  /** Opens the bundled PDF manual in the system's PDF viewer. False if this build has none. */
  appOpenManual: () => Promise<boolean>
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
  /** Fetches an airport's full taxiway network from the sim and replaces the cache for it.
   *  Genuinely slow for a large airport (minutes, not seconds) — only ever call this from an
   *  explicit user action (a "load taxi chart" toggle), never automatically. */
  navdataRefreshTaxiNetwork: (icao: string) => Promise<void>
  /** True once navdataRefreshTaxiNetwork has completed for this ICAO at least once. */
  navdataHasTaxiNetwork: (icao: string) => Promise<boolean>
  navdataGetTaxiNetwork: (icao: string) => Promise<NavdataTaxiSegment[]>
  /** An airport's stands, fetched from the sim on first ask (seconds) and cached; empty when
   *  the sim isn't running and nothing's cached. */
  navdataGetStands: (icao: string) => Promise<NavdataStand[]>
  /** Each fleet aircraft's last stand (stand-positions.md). */
  fleetListLastParked: () => Promise<AircraftLastParked[]>
  /** Pushes the current live selection to the main process so it's available whenever the
   *  active flight completes — manual finish *or* automatic shutdown detection, neither of
   *  which round-trips through the renderer (TrackingController). Call on every change
   *  while a flight is actively being tracked; a no-op call with nothing tracked is
   *  harmless (TrackingController just caches it for the flight that starts next). */
  trackingSetProcedureSelection: (selection: ProcedureSelection) => Promise<void>
  /** Sets (or, with null/blank, clears) the destination of the free flight being tracked —
   *  the start dialog's Destination is optional, and this is how one is added afterwards. A
   *  plan, not a promise: the real touchdown still resolves the actual arrival. */
  trackingSetDestination: (icao: string | null) => Promise<void>
  /** Same, for the departure airport (v1.1.2). */
  trackingSetDeparture: (icao: string | null) => Promise<void>
  /** The flight left 'active' if the app quit or crashed before it reached 'completed' or
   *  'abandoned' — checked once at startup (main/index.ts), so this only ever returns
   *  non-null until the user answers the resume/discard prompt it's meant to drive (or
   *  null immediately, the common case: nothing was orphaned). */
  trackingGetOrphanedFlight: () => Promise<Flight | null>
  /** User chose to resume the orphaned flight above — picks phase detection back up from
   *  where its last persisted track point left off (TrackingController.resume). */
  trackingResumeOrphaned: (flightId: number) => Promise<void>
  /** User chose to discard the orphaned flight above — deletes it (and its track points)
   *  rather than leaving it stuck in 'active' forever. */
  trackingDiscardOrphaned: (flightId: number) => Promise<void>
  settingsGetGsxRemote: () => Promise<GsxRemoteSettings>
  /** Changing host/port/enabled restarts the live connection (or stops it, if disabled). */
  settingsSetGsxRemote: (settings: GsxRemoteSettings) => Promise<void>
  /** Current status, for a renderer mounting after the initial connect already happened —
   *  same reasoning as getSimConnectionStatus above. */
  gsxRemoteGetStatus: () => Promise<GsxRemoteConnectionStatus>
  onGsxRemoteStatus: (listener: (status: GsxRemoteConnectionStatus) => void) => () => void
  /** Current services, for a renderer mounting after GSX already pushed a snapshot — without
   *  this, a panel mounted (or remounted, e.g. by switching tabs and back) after connect but
   *  before the next `services` patch would show nothing until GSX happened to send one. */
  gsxRemoteGetServices: () => Promise<GsxRemoteServiceStatus[]>
  onGsxRemoteServices: (listener: (services: GsxRemoteServiceStatus[]) => void) => () => void
  /** Current gate info, for a renderer mounting after the initial connect already happened. */
  gsxRemoteGetGateInfo: () => Promise<GsxRemoteGateInfo | null>
  onGsxRemoteGate: (listener: (gate: GsxRemoteGateInfo | null) => void) => () => void
  /** Current menu, same "mounting late shouldn't mean missing state" reasoning as
   *  gsxRemoteGetServices above. */
  gsxRemoteGetMenu: () => Promise<GsxRemoteMenuState>
  onGsxRemoteMenu: (listener: (menu: GsxRemoteMenuState) => void) => () => void
  /** Current prompt, same reasoning as gsxRemoteGetServices/gsxRemoteGetMenu above. */
  gsxRemoteGetPrompt: () => Promise<GsxRemotePromptState | null>
  /** Pushed with null when GSX clears the prompt (answered, cancelled, or a new connection). */
  onGsxRemotePrompt: (listener: (prompt: GsxRemotePromptState | null) => void) => () => void
  /** The three remotely-triggerable command-bar buttons plus SimBrief's own reload state —
   *  see GsxRemoteCommand's doc comment for why SETTINGS is never included. Combines
   *  `state.commandIcons`/`commandIconsSvg`/`simbrief`, same "separate top-level wire keys,
   *  one value for callers" pattern as gate/menu. */
  gsxRemoteGetCommandBar: () => Promise<GsxRemoteCommandBar>
  onGsxRemoteCommandBar: (listener: (commandBar: GsxRemoteCommandBar) => void) => () => void
  /** Picks the menu entry at this index — the *only* interaction GSX's own menu model
   *  exposes (docs/gsx-notes.md). No-op if not connected. */
  gsxRemotePickMenu: (index: number) => Promise<void>
  /** Sends the gate-search box's whole current text (`menu.search`, not a delta) — GSX
   *  re-filters `menu.entries` itself. Only meaningful while `searchActive`. */
  gsxRemoteSearch: (text: string) => Promise<void>
  /** Opens the menu tree if it's currently closed, or closes it if open — same single
   *  toggle GSX's own client's permanent header sends (`menu.toggle`/`menu.close`). This
   *  is how a real GSX remote opens the menu without the in-sim panel ever opening; WingLog
   *  needs to call it explicitly, the same way, rather than passively waiting for someone
   *  else to have already opened it (docs/gsx-notes.md). */
  gsxRemoteToggleMenu: () => Promise<void>
  gsxRemoteSubmitPrompt: (gen: number, text: string) => Promise<void>
  gsxRemoteCancelPrompt: (gen: number) => Promise<void>
  /** Runs one of the three command-bar commands (`command.run`) — GSX's own client requires
   *  a second confirming call for RESTART_COUATL (the UI enforces this, not this method). */
  gsxRemoteRunCommand: (id: GsxRemoteCommandId) => Promise<void>
  settingsGetBeyondAtc: () => Promise<BeyondAtcSettings>
  /** Changing host/enabled restarts the live connection (or stops it, if disabled). Port is
   *  fixed (BeyondAtcService's own BEYONDATC_PORT), never sent from here. */
  settingsSetBeyondAtc: (settings: BeyondAtcSettings) => Promise<void>
  /** Current status, for a renderer mounting after the initial connect already happened. */
  beyondAtcGetStatus: () => Promise<BeyondAtcConnectionStatus>
  onBeyondAtcStatus: (listener: (status: BeyondAtcConnectionStatus) => void) => () => void
  /** Current combined state, same "mounting late shouldn't mean missing state" reasoning as
   *  GSX Remote's own getServices/getMenu. */
  beyondAtcGetState: () => Promise<BeyondAtcState>
  onBeyondAtcState: (listener: (state: BeyondAtcState) => void) => () => void
  /** The current transcript buffer (last 100 lines), for a renderer mounting mid-flight. */
  beyondAtcGetTranscript: () => Promise<BeyondAtcTranscriptEntry[]>
  onBeyondAtcTranscript: (listener: (transcript: BeyondAtcTranscriptEntry[]) => void) => () => void
  /** Fires the given entry from the live Actions list (`set_action`) — no-op if not
   *  connected. */
  beyondAtcSetAction: (label: string) => Promise<void>
  beyondAtcSetFrequency: (frequency: string) => Promise<void>
  beyondAtcSetFrequencyCom2: (frequency: string) => Promise<void>
  /** `set_autotune`/`set_autorespond` — confirmed working two-way control, 2026-09-29
   *  (winglog-backend's docs/beyondatc-notes.md). No-op if not connected. */
  beyondAtcSetAutoTune: (value: boolean) => Promise<void>
  beyondAtcSetAutoRespond: (value: boolean) => Promise<void>
  settingsGetUpdates: () => Promise<UpdateSettings>
  settingsSetUpdates: (settings: UpdateSettings) => Promise<void>
  updatesGetStatus: () => Promise<UpdateStatus>
  onUpdateStatus: (listener: (status: UpdateStatus) => void) => () => void
  /** Checks GitHub now, whatever the automatic-check setting, and returns the result. */
  updatesCheckNow: () => Promise<UpdateStatus>
  updatesSkipVersion: (version: string) => Promise<void>
  /** Opens the latest release's page — the URL main validated, never one from here. */
  updatesOpenRelease: () => Promise<void>
  /** WingLog's auto step climb — see BeyondAtcStepClimbStatus. */
  beyondAtcGetStepClimb: () => Promise<BeyondAtcStepClimbStatus>
  onBeyondAtcStepClimb: (listener: (status: BeyondAtcStepClimbStatus) => void) => () => void
  beyondAtcSetStepClimb: (enabled: boolean) => Promise<void>
  beyondAtcGetArrival: () => Promise<BeyondAtcArrivalClearance | null>
  onBeyondAtcArrival: (listener: (clearance: BeyondAtcArrivalClearance | null) => void) => () => void
  setupGetState: () => Promise<SetupState>
  setupGetContext: () => Promise<SetupContext>
  /** Finished or closed: never shown again unless reopened from Settings → About. */
  setupComplete: () => Promise<void>
}
