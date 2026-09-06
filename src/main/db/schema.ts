import { sql } from 'drizzle-orm'
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// Identity + linkage only, per docs/decisions.md's 2026-09-01 Fleet-simplification entry:
// all performance data (weights, equip, PBN, wake cat...) lives in the linked SimBrief
// profile now, not duplicated here. Hours/cycles are computed live from flight history
// (flight-repo.ts's getFleetStats) rather than stored — this table never carried the
// authoritative values for those anyway.
export const aircraft = sqliteTable('aircraft', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  registration: text('registration').notNull().unique(),
  icaoType: text('icao_type').notNull(),
  operator: text('operator'),
  operatorIata: text('operator_iata'),
  // ICAO code of the operator — SimBrief's `airline` generation parameter wants this,
  // not IATA (which drives the logo instead). Neither derives reliably from the other,
  // so both are stored (docs/decisions.md, SimBrief-generation entry).
  operatorIcao: text('operator_icao'),
  simbriefAirframeId: text('simbrief_airframe_id'),
  // A chosen SimBrief *default* type (e.g. this A320 flies as SimBrief's "A20N Neo"
  // rather than its base A320 default) — separate from simbriefAirframeId, which is a
  // saved custom profile. Dispatch's precedence: custom airframe ID if set, else
  // simbrief_type ?? icaoType (docs/decisions.md, fleet-simbrief-airframe entry). Not a
  // vendored/validated list — SimBrief validates the type itself and falls back to its
  // own default on anything it doesn't recognise, same as icaoType already does.
  simbriefType: text('simbrief_type'),
  currentIcao: text('current_icao'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(current_timestamp)`),
  // Cloud-sync identity (flightdeck-backend/docs/plans/cloud-sync.md). Nullable rather
  // than NOT NULL: SQLite's ALTER TABLE ADD COLUMN bakes a non-constant default (e.g. a
  // random-blob expression) into every existing row identically, which would give every
  // pre-migration aircraft the *same* uuid — the opposite of what sync identity needs.
  // The migration backfills existing rows with distinct values via a plain per-row
  // UPDATE instead; every repo write path from here on always supplies both explicitly,
  // so in practice this is never actually null once written by this app version.
  uuid: text('uuid'),
  updatedAt: text('updated_at')
})

// Flight table per PLAN.md §5. `law_kg` in that sketch was landing weight — named
// `ldw_kg` here to match both SimBrief's own field name (`est_ldw`) and standard
// aviation terminology. Altitude and weights are SI per docs/decisions.md §5; times are
// ISO 8601 UTC strings (SimBrief reports unix epoch seconds — converted on fetch).
// actual_*/block/air/fuel_out/fuel_in/fuel_burn/sim_version stay null until M4 tracking
// fills them in; M3 only ever writes a 'planned' row from a fetched OFP.
export const flight = sqliteTable('flight', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  aircraftId: integer('aircraft_id')
    .notNull()
    .references(() => aircraft.id),
  status: text('status', { enum: ['planned', 'active', 'completed', 'abandoned'] })
    .notNull()
    .default('planned'),
  flightNumber: text('flight_number'),
  depIcao: text('dep_icao').notNull(),
  arrIcao: text('arr_icao').notNull(),
  altnIcao: text('altn_icao'),
  routeString: text('route_string'),
  cruiseAltM: real('cruise_alt_m'),
  schedOutUtc: text('sched_out_utc'),
  schedInUtc: text('sched_in_utc'),
  actualOutUtc: text('actual_out_utc'),
  actualOffUtc: text('actual_off_utc'),
  actualOnUtc: text('actual_on_utc'),
  actualInUtc: text('actual_in_utc'),
  blockMinutes: real('block_minutes'),
  airMinutes: real('air_minutes'),
  fuelPlannedKg: real('fuel_planned_kg'),
  fuelOutKg: real('fuel_out_kg'),
  fuelInKg: real('fuel_in_kg'),
  fuelBurnKg: real('fuel_burn_kg'),
  pax: integer('pax'),
  cargoKg: real('cargo_kg'),
  zfwKg: real('zfw_kg'),
  towKg: real('tow_kg'),
  ldwKg: real('ldw_kg'),
  ofpId: text('ofp_id'),
  ofpJson: text('ofp_json'),
  simVersion: text('sim_version'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(current_timestamp)`),
  // See aircraft.uuid's comment for why these are nullable rather than NOT NULL.
  uuid: text('uuid'),
  updatedAt: text('updated_at'),
  // Derived, simplified flown path (flightdeck-backend/docs/plans/cloud-sync.md, "The
  // flown route, not the full track") — a lightweight polyline computed from this
  // flight's own track_point rows at completion, for cloud sync and a second device's
  // map. Null for any flight that hasn't completed, or completed before this existed;
  // the full-resolution track_point table stays local-only and is never itself synced.
  flownRouteJson: text('flown_route_json')
})

// Local app settings — key/value so future milestones (map tile source, etc.) don't need
// a new migration per setting. Not an "account": nothing here leaves the machine.
export const appSetting = sqliteTable('app_setting', {
  key: text('key').primaryKey(),
  value: text('value').notNull()
})

// A snapshot of a matched GSX ground-service receipt, taken at flight completion rather
// than read live from the folder — GSX's own admin UI can bulk-delete old receipts, so a
// Logbook that only ever reads the live folder would silently lose historical costs the
// day someone tidies up (docs/decisions.md, gsx-invoices entry). logoDataUri is stripped
// from receiptJson before storage — 16-30 KB of repeated base64 PNG nothing here renders.
export const flightInvoice = sqliteTable('flight_invoice', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  flightId: integer('flight_id')
    .notNull()
    .references(() => flight.id),
  serviceGroup: text('service_group', { enum: ['catering', 'fuel', 'handling', 'passengerBus'] }).notNull(),
  receiptId: text('receipt_id').notNull(),
  issuedUtc: text('issued_utc').notNull(),
  icao: text('icao').notNull(),
  tail: text('tail').notNull(),
  operator: text('operator'),
  // USD equivalent GSX itself computed, for cross-currency totals — never re-derived from
  // the local-currency text, which isn't safely parseable (docs/gsx-notes.md).
  totalUsd: real('total_usd'),
  totalText: text('total_text'),
  sourceHtmlPath: text('source_html_path').notNull(),
  receiptJson: text('receipt_json').notNull(),
  // See aircraft.uuid's comment for why these are nullable rather than NOT NULL. No
  // createdAt column exists on this table to backfill updatedAt from — the migration
  // backfills it from the parent flight's createdAt instead, the closest real timestamp
  // available for a pre-existing receipt.
  uuid: text('uuid'),
  updatedAt: text('updated_at')
})

// track_point per PLAN.md §5 — "keep sparse; this table gets big". FlightRecorder
// (src/main/tracking) downsamples cruise to ~15s intervals and writes every other phase
// at the sim feed's own 1 Hz, so a short flight is a few hundred rows, not tens of
// thousands. SI throughout per docs/decisions.md §5 — convert only at the UI layer.
export const trackPoint = sqliteTable('track_point', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  flightId: integer('flight_id')
    .notNull()
    .references(() => flight.id),
  tsUtc: text('ts_utc').notNull(),
  latitude: real('latitude').notNull(),
  longitude: real('longitude').notNull(),
  altitudeM: real('altitude_m').notNull(),
  altitudeAglM: real('altitude_agl_m').notNull(),
  indicatedAirspeedMs: real('indicated_airspeed_ms').notNull(),
  // Default 0 only so ALTER TABLE ADD COLUMN can backfill pre-existing NOT NULL rows —
  // every new row from FlightRecorder.toTrackPoint always supplies a real value, same
  // pattern as gForce/windSpeedMs/windDirectionDeg below.
  machSpeed: real('mach_speed').notNull().default(0),
  groundSpeedMs: real('ground_speed_ms').notNull(),
  verticalSpeedMs: real('vertical_speed_ms').notNull(),
  headingTrueDeg: real('heading_true_deg').notNull(),
  pitchDeg: real('pitch_deg').notNull(),
  bankDeg: real('bank_deg').notNull(),
  phase: text('phase', {
    enum: ['preflight', 'pushback', 'taxi', 'takeoff', 'climb', 'cruise', 'descent', 'landing', 'shutdown']
  }).notNull(),
  onGround: integer('on_ground', { mode: 'boolean' }).notNull(),
  fuelKg: real('fuel_kg').notNull(),
  // Added for landing analysis (PLAN.md M6, docs/decisions.md) — already computed and
  // shown live (Track's telemetry overlay) from every tick, but discarded before this;
  // a landing record needs at least G-force and wind at the touchdown moment, and having
  // them on every point (not just the touchdown one) also lets a future wind/G trace be
  // plotted alongside the existing altitude/speed charts. Defaults exist only so SQLite's
  // ALTER TABLE ADD COLUMN can backfill pre-existing rows (a NOT NULL column added via
  // ALTER TABLE must have one) — every new row from FlightRecorder.toTrackPoint always
  // supplies real values explicitly, so these are never actually relied on going forward.
  gForce: real('g_force').notNull().default(1),
  windSpeedMs: real('wind_speed_ms').notNull().default(0),
  windDirectionDeg: real('wind_direction_deg').notNull().default(0)
})

// One row per flight's touchdown, captured where the phase machine already detects it
// (descent -> landing, the on-ground false->true transition — TrackingController's
// existing onRecorded-guarded branch). SI throughout per docs/decisions.md §5. Runway
// fields are null when no matching runway end was found in resources/runways.csv (an
// unlisted airstrip, or a match outside the plausible heading tolerance) — a landing
// record without runway context is still worth having (touchdown rate, G, wind alone).
export const landing = sqliteTable('landing', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  flightId: integer('flight_id')
    .notNull()
    .unique()
    .references(() => flight.id),
  touchdownTsUtc: text('touchdown_ts_utc').notNull(),
  verticalSpeedMs: real('vertical_speed_ms').notNull(),
  gForce: real('g_force').notNull(),
  pitchDeg: real('pitch_deg').notNull(),
  bankDeg: real('bank_deg').notNull(),
  headingTrueDeg: real('heading_true_deg').notNull(),
  indicatedAirspeedMs: real('indicated_airspeed_ms').notNull(),
  groundSpeedMs: real('ground_speed_ms').notNull(),
  windSpeedMs: real('wind_speed_ms').notNull(),
  windDirectionDeg: real('wind_direction_deg').notNull(),
  headwindMs: real('headwind_ms'),
  crosswindMs: real('crosswind_ms'),
  runwayIdent: text('runway_ident'),
  distanceFromThresholdM: real('distance_from_threshold_m'),
  centrelineOffsetM: real('centreline_offset_m'),
  flapSetting: integer('flap_setting'),
  // 'derived' throughout — scripts/spike-landing.ts confirmed 2026-09-04 that MSFS 2024's
  // dedicated touchdown SimVars disagree with the derived value in trend, not just
  // magnitude, across a real bounce; nothing writes 'simvar'.
  touchdownSource: text('touchdown_source', { enum: ['simvar', 'derived'] }).notNull().default('derived'),
  // See aircraft.uuid's comment for why these are nullable rather than NOT NULL. The
  // migration backfills updatedAt from touchdownTsUtc, the closest real timestamp
  // available for a pre-existing landing record.
  uuid: text('uuid'),
  updatedAt: text('updated_at')
})
