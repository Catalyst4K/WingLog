/**
 * Facility Data Definition field names and record parsing for the navdata provider
 * (src/main/navdata/) — kept in src/main/sim/ next to simvars.ts, per CLAUDE.md's "SimVar/
 * facility names live in one place" rule. Field lists and read order are sim-confirmed
 * live, 2026-09-08 (winglog-backend's docs/navdata-notes.md, scripts/spike-facilities.ts
 * — same spike, reused here) against a real MSFS 2024: RUNWAY, DEPARTURE/ARRIVAL,
 * RUNWAY_TRANSITION, ENROUTE_TRANSITION and APPROACH_LEG record shapes all match what that
 * spike observed. Registration order = buffer read order, exactly like simvars.ts.
 *
 * APPROACH/APPROACH_TRANSITION/FINAL_APPROACH_LEG parsing added 2026-09-08 for
 * winglog-backend's navdata-without-navigraph.md Phase 5 (real approach selection) —
 * spike-confirmed live the same day against a real MSFS 2024 session
 * (winglog-backend's docs/navdata-notes.md, "approach procedures, previously out of
 * scope" entry). `MISSED_APPROACH_LEG` deliberately still unregistered — nothing built so
 * far needs a go-around path.
 *
 * **Where a procedure's legs actually live is airport/procedure-dependent — confirmed live,
 * 2026-09-08, against real EGLL and VHHH departures/arrivals** (a nested
 * `OPEN APPROACH_LEG`/`CLOSE APPROACH_LEG` block *inside* `RUNWAY_TRANSITION` and
 * `ENROUTE_TRANSITION` works — not something either the original spike or the SDK reference
 * table made obvious, since only a leg *count* was ever requested there before). Every real
 * SID seen at both airports had `N_APPROACH_LEGS = 0` at the procedure's own top level and
 * all its real legs nested inside its one `RUNWAY_TRANSITION` (e.g. EGLL's BPK5K: 6 legs,
 * all under its 09L runway transition); EGLL's STARs were the reverse — `N_RUNWAY_TRANSITIONS
 * = 0` and every real leg at the procedure's own top level (e.g. ALES1H: 6 common legs, no
 * transitions at all). No enroute-transition-nested legs were observed in either airport's
 * data (VHHH's SIDs/STARs register zero enroute transitions outright; EGLL's do too) — the
 * nesting is registered defensively below since it's the same confirmed mechanism, but it's
 * untested against real data with a non-zero `N_ENROUTE_TRANSITIONS`. `getProcedureWaypoints`
 * therefore concatenates all three groups (runway-transition legs, common legs,
 * enroute-transition legs) rather than assuming legs live in only one place.
 */
import { type RawBuffer } from 'node-simconnect'
import { offsetBy } from '@shared/geo'

export const enum NavdataDefId {
  RUNWAYS = 10,
  DEPARTURES = 11,
  ARRIVALS = 12,
  APPROACHES = 13,
  TAXI_POINTS = 14,
  /** Two separate definitions for the same TAXI_PATH shape, filtered to different `TYPE`
   *  values — a facility data definition's filter (`addFacilityDataDefinitionFilter`) matches
   *  exactly one value, and which numeric `TYPE` is really "Taxi" vs "Path" is unconfirmed
   *  (winglog-backend's docs/navdata-notes.md, 2026-09-28) — TYPE 1 and TYPE 4 are both
   *  fetched and merged rather than guessing one. */
  TAXI_PATHS_TYPE_1 = 15,
  TAXI_PATHS_TYPE_4 = 16,
  TAXI_NAMES = 17,
  TAXI_PARKINGS = 18
}

/** 0/1/2/3 = none/L/R/C — confirmed against two real airports with known real layouts
 *  (EGLL: designators 1/2 only, no C; VHHH: 1/2/3, its real three-runway system) —
 *  docs/navdata-notes.md. */
const RUNWAY_DESIGNATORS = ['', 'L', 'R', 'C'] as const

/**
 * A runway end's ident from SimConnect's number and designator.
 *
 * @param number Runway number, 1 to 36.
 * @param designator 0 to 3: none, L, R, C.
 * @returns The ident, e.g. '07L'.
 */
export function runwayIdent(number: number, designator: number): string {
  const suffix = RUNWAY_DESIGNATORS[designator] ?? ''
  return `${String(number).padStart(2, '0')}${suffix}`
}

export interface ParsedAirportHeader {
  icao: string
}

/**
 * Registers the AIRPORT header with its ICAO only.
 *
 * @param addField Adds one field to the facility definition being built, in read order.
 */
export function addAirportIcaoField(addField: (name: string) => void): void {
  addField('OPEN AIRPORT')
  addField('ICAO')
}

/**
 * Reads the header addAirportIcaoField registered.
 *
 * @param d The record buffer, positioned at this record.
 * @returns The airport's ICAO.
 */
export function parseAirportHeader(d: RawBuffer): ParsedAirportHeader {
  return { icao: d.readString8() }
}

export interface ParsedAirportHeaderWithLatLon {
  icao: string
  latitude: number
  longitude: number
}

/** Every taxi-network definition below registers this same shape at the airport level (not
 *  just `addAirportIcaoField`'s ICAO-only shape) — even the three that don't themselves need
 *  the reference point — so every request's AIRPORT record has an identical buffer layout,
 *  sidestepping the per-definition buffer-shape gotcha `fetchAirportNavdata`'s own comment
 *  describes. Only the TAXI_POINTS fetch actually uses the lat/lon (as the reference point for
 *  `biasToLatLon`).
 *
 * @param addField Adds one field to the facility definition being built, in read order.
 */
export function addAirportIcaoLatLonFields(addField: (name: string) => void): void {
  addField('OPEN AIRPORT')
  addField('ICAO')
  addField('LATITUDE')
  addField('LONGITUDE')
}

/**
 * Reads the header addAirportIcaoLatLonFields registered.
 *
 * @param d The record buffer, positioned at this record.
 * @returns The ICAO and the airport's reference point, in degrees.
 */
export function parseAirportHeaderWithLatLon(d: RawBuffer): ParsedAirportHeaderWithLatLon {
  const icao = d.readString8()
  const latitude = d.readFloat64()
  const longitude = d.readFloat64()
  return { icao, latitude, longitude }
}

export interface ParsedRunway {
  latitude: number
  longitude: number
  headingDeg: number
  lengthM: number
  widthM: number
  /** Raw SimConnect surface-type integer — not yet mapped to a name, unlike the
   *  runway-designator enum above (unconfirmed against an authoritative table). */
  surface: number
  primaryIdent: string
  secondaryIdent: string
}

/**
 * Registers the RUNWAY records: position, heading, size, surface and both ends' idents.
 *
 * @param addField Adds one field to the facility definition being built, in read order.
 */
export function addRunwayFields(addField: (name: string) => void): void {
  addField('N_RUNWAYS')
  addField('OPEN RUNWAY')
  addField('LATITUDE')
  addField('LONGITUDE')
  addField('HEADING')
  addField('LENGTH')
  addField('WIDTH')
  addField('SURFACE')
  addField('PRIMARY_NUMBER')
  addField('PRIMARY_DESIGNATOR')
  addField('SECONDARY_NUMBER')
  addField('SECONDARY_DESIGNATOR')
  addField('CLOSE RUNWAY')
}

/**
 * Reads one RUNWAY record addRunwayFields registered.
 *
 * @param d The record buffer, positioned at this record.
 * @returns The runway, metres and degrees true.
 */
export function parseRunway(d: RawBuffer): ParsedRunway {
  const latitude = d.readFloat64()
  const longitude = d.readFloat64()
  const headingDeg = d.readFloat32()
  const lengthM = d.readFloat32()
  const widthM = d.readFloat32()
  const surface = d.readInt32()
  const primaryNumber = d.readInt32()
  const primaryDesignator = d.readInt32()
  const secondaryNumber = d.readInt32()
  const secondaryDesignator = d.readInt32()
  return {
    latitude,
    longitude,
    headingDeg,
    lengthM,
    widthM,
    surface,
    primaryIdent: runwayIdent(primaryNumber, primaryDesignator),
    secondaryIdent: runwayIdent(secondaryNumber, secondaryDesignator)
  }
}

export interface ParsedProcedureHeader {
  name: string
  nRunwayTransitions: number
  nEnrouteTransitions: number
  nApproachLegs: number
}

export interface ParsedRunwayTransition {
  runwayIdent: string
  nApproachLegs: number
}

export interface ParsedEnrouteTransition {
  name: string
  nApproachLegs: number
}

export interface ParsedLeg {
  type: number
  fixIdent: string | null
  /** Ident of the fix's facility type — 'W' (waypoint), 'V' (VOR), 'N' (NDB), 'R' (runway
   *  threshold/aiming fix), or null for a heading/manual-termination leg with no real fix.
   *  ASCII-decoded from FIX_TYPE, confirmed against real legs — docs/navdata-notes.md. */
  fixType: 'W' | 'V' | 'N' | 'R' | null
  fixLatitude: number
  fixLongitude: number
  turnDirection: number
  courseDeg: number
  altitude1: number
  altitude2: number
  speedLimit: number
  /** ROUTE_DISTANCE, metres. Only meaningful for distance-terminated legs — FC (type 9) and
   *  FD (type 10) — where `fixIdent` is the navaid the leg is anchored to and this is how far
   *  along `courseDeg` it runs (confirmed live 2026-09-18: EGLL's LAM transition FC leg reads
   *  20372 m = 11.0 nm, the FMC's "LAM/11"). 0 for every other leg type. */
  routeDistanceM: number
}

const FIX_TYPE_CODES: Record<number, ParsedLeg['fixType']> = { 87: 'W', 86: 'V', 78: 'N', 82: 'R' }

/** Shared field list — identical layout for every leg-bearing struct (APPROACH_LEG,
 *  FINAL_APPROACH_LEG, MISSED_APPROACH_LEG all share it per the MSFS 2024 SDK reference;
 *  only APPROACH_LEG is actually registered here, see the module doc comment).
 *
 * @param addField Adds one field to the facility definition being built, in read order.
 */
export function addLegFields(addField: (name: string) => void): void {
  addField('TYPE')
  addField('FIX_ICAO')
  addField('FIX_TYPE')
  addField('FIX_LATITUDE')
  addField('FIX_LONGITUDE')
  addField('TURN_DIRECTION')
  addField('COURSE')
  addField('ALTITUDE1')
  addField('ALTITUDE2')
  addField('SPEED_LIMIT')
  addField('ROUTE_DISTANCE')
}

/**
 * Reads one leg addLegFields registered.
 *
 * @param d The record buffer, positioned at this record.
 * @returns The leg.
 */
export function parseLeg(d: RawBuffer): ParsedLeg {
  const type = d.readInt32()
  const fixIcaoRaw = d.readString8()
  const fixTypeCode = d.readInt32()
  const fixLatitude = d.readFloat64()
  const fixLongitude = d.readFloat64()
  const turnDirection = d.readInt32()
  const courseDeg = d.readFloat32()
  const altitude1 = d.readFloat32()
  const altitude2 = d.readFloat32()
  const speedLimit = d.readFloat32()
  const routeDistanceM = d.readFloat32()
  return {
    type,
    fixIdent: fixIcaoRaw.trim() === '' ? null : fixIcaoRaw,
    fixType: FIX_TYPE_CODES[fixTypeCode] ?? null,
    fixLatitude,
    fixLongitude,
    turnDirection,
    courseDeg,
    altitude1,
    altitude2,
    speedLimit,
    routeDistanceM
  }
}

/** Builds the full DEPARTURE/ARRIVAL facility definition on `defId` — the airport header,
 *  the procedure header, runway/enroute transition summaries, and the procedure's own
 *  common leg list. Reused for both kinds, since DEPARTURE/ARRIVAL share the same shape.
 *
 * @param addField Adds one field to a definition, in read order.
 * @param defId The definition to build.
 * @param kind Departures (SIDs) or arrivals (STARs).
 */
export function addProcedureTreeDefinition(
  addField: (defId: NavdataDefId, name: string) => void,
  defId: NavdataDefId,
  kind: 'DEPARTURE' | 'ARRIVAL'
): void {
  const add = (name: string): void => addField(defId, name)
  add('OPEN AIRPORT')
  add('ICAO')
  add(kind === 'DEPARTURE' ? 'N_DEPARTURES' : 'N_ARRIVALS')
  add(`OPEN ${kind}`)
  add('NAME')
  add('N_RUNWAY_TRANSITIONS')
  add('N_ENROUTE_TRANSITIONS')
  add('N_APPROACH_LEGS')
  add('OPEN RUNWAY_TRANSITION')
  add('RUNWAY_NUMBER')
  add('RUNWAY_DESIGNATOR')
  add('N_APPROACH_LEGS')
  add('OPEN APPROACH_LEG')
  addLegFields((name) => addField(defId, name))
  add('CLOSE APPROACH_LEG')
  add('CLOSE RUNWAY_TRANSITION')
  add('OPEN ENROUTE_TRANSITION')
  add('NAME')
  add('N_APPROACH_LEGS')
  add('OPEN APPROACH_LEG')
  addLegFields((name) => addField(defId, name))
  add('CLOSE APPROACH_LEG')
  add('CLOSE ENROUTE_TRANSITION')
  add('OPEN APPROACH_LEG')
  addLegFields((name) => addField(defId, name))
  add('CLOSE APPROACH_LEG')
  add(`CLOSE ${kind}`)
  add('CLOSE AIRPORT')
}

/**
 * Reads a SID or STAR header addProcedureTreeDefinition registered.
 *
 * @param d The record buffer, positioned at this record.
 * @returns The procedure's name and how many transitions and legs follow.
 */
export function parseProcedureHeader(d: RawBuffer): ParsedProcedureHeader {
  return {
    name: d.readString8(),
    nRunwayTransitions: d.readInt32(),
    nEnrouteTransitions: d.readInt32(),
    nApproachLegs: d.readInt32()
  }
}

/**
 * Reads one RUNWAY_TRANSITION header.
 *
 * @param d The record buffer, positioned at this record.
 * @returns The runway and how many legs follow.
 */
export function parseRunwayTransition(d: RawBuffer): ParsedRunwayTransition {
  const runwayNumber = d.readInt32()
  const runwayDesignator = d.readInt32()
  const nApproachLegs = d.readInt32()
  return { runwayIdent: runwayIdent(runwayNumber, runwayDesignator), nApproachLegs }
}

/**
 * Reads one ENROUTE_TRANSITION header.
 *
 * @param d The record buffer, positioned at this record.
 * @returns The transition's name and how many legs follow.
 */
export function parseEnrouteTransition(d: RawBuffer): ParsedEnrouteTransition {
  return { name: d.readString8(), nApproachLegs: d.readInt32() }
}

/** `APPROACH.TYPE`'s raw integer, mapped with confidence — cross-validated against real
 *  EGLL/VHHH approach counts rather than an authoritative SDK table (none found), 2026-09-08
 *  (winglog-backend's docs/navdata-notes.md): every runway end at both airports had
 *  exactly one `type=4` and, where present, exactly one `type=5`, matching real published
 *  ILS + LOC-only-backup pairs; `type=10` was the only one ever duplicated per runway,
 *  matching real "RNP Y"/"RNP Z" pairs (confirmed via SUFFIX on VHHH 07R's two `type=10`
 *  approaches). An unrecognized code falls back to its own raw number rather than a made-up
 *  label — better to show "TYPE 7" than silently mislabel something as ILS. */
const APPROACH_TYPE_LABELS: Record<number, string> = { 4: 'ILS', 5: 'LOC', 10: 'RNAV' }

/**
 * The approach type's name, from APPROACH_TYPE_LABELS.
 *
 * @param type APPROACH.TYPE's raw value.
 * @returns 'ILS', 'LOC', 'RNAV', or 'TYPE n' for anything else.
 */
function approachTypeLabel(type: number): string {
  return APPROACH_TYPE_LABELS[type] ?? `TYPE ${type}`
}

/** `APPROACH.SUFFIX`'s raw integer is the ASCII code of the approach's letter suffix (or
 *  '0' for none) — confirmed clean 2026-09-08: 32/40 approaches seen had no suffix, the rest
 *  were 'Y'/'Z'. Falls back to the raw character for anything outside that observed set
 *  rather than assuming — the encoding itself (ASCII code of a single char) is confirmed,
 *  just not every value it can take.
 *
 * @param suffixCode APPROACH.SUFFIX's raw value.
 * @returns The letter, or '' for none.
 */
function suffixLetter(suffixCode: number): string {
  if (suffixCode === 0 || suffixCode === 48) return ''
  return String.fromCharCode(suffixCode)
}

export interface ParsedApproachHeader {
  /** Constructed display identifier, e.g. "ILS 07C" / "RNP Z 07R" — approaches have no NAME
   *  field of their own (unlike SID/STAR), so this is built from TYPE + runway + SUFFIX, the
   *  same fields a real approach chart's own title is built from. */
  identifier: string
  runwayIdent: string
  nTransitions: number
  nFinalApproachLegs: number
  nMissedApproachLegs: number
}

/**
 * Registers the APPROACHES definition: each approach's header, its transitions and its final legs.
 *
 * @param addField Adds one field to the APPROACHES definition, in read order.
 */
export function addApproachTreeDefinition(addField: (defId: NavdataDefId, name: string) => void): void {
  const defId = NavdataDefId.APPROACHES
  const add = (name: string): void => addField(defId, name)
  add('OPEN AIRPORT')
  add('ICAO')
  add('N_APPROACHES')
  add('OPEN APPROACH')
  add('TYPE')
  add('SUFFIX')
  add('RUNWAY_NUMBER')
  add('RUNWAY_DESIGNATOR')
  add('N_TRANSITIONS')
  add('N_FINAL_APPROACH_LEGS')
  add('N_MISSED_APPROACH_LEGS')
  add('OPEN APPROACH_TRANSITION')
  add('NAME')
  add('N_APPROACH_LEGS')
  add('OPEN APPROACH_LEG')
  addLegFields((name) => addField(defId, name))
  add('CLOSE APPROACH_LEG')
  add('CLOSE APPROACH_TRANSITION')
  add('OPEN FINAL_APPROACH_LEG')
  addLegFields((name) => addField(defId, name))
  add('CLOSE FINAL_APPROACH_LEG')
  add('CLOSE APPROACH')
  add('CLOSE AIRPORT')
}

/**
 * Reads one APPROACH header addApproachTreeDefinition registered.
 *
 * @param d The record buffer, positioned at this record.
 * @returns The approach, named as a chart would ("ILS Z 07R"), and how many transitions and legs follow.
 */
export function parseApproachHeader(d: RawBuffer): ParsedApproachHeader {
  const type = d.readInt32()
  const suffixCode = d.readInt32()
  const runwayNumber = d.readInt32()
  const runwayDesignator = d.readInt32()
  const nTransitions = d.readInt32()
  const nFinalApproachLegs = d.readInt32()
  const nMissedApproachLegs = d.readInt32()
  const rwyIdent = runwayIdent(runwayNumber, runwayDesignator)
  const suffix = suffixLetter(suffixCode)
  return {
    identifier: `${approachTypeLabel(type)}${suffix ? ` ${suffix}` : ''} ${rwyIdent}`,
    runwayIdent: rwyIdent,
    nTransitions,
    nFinalApproachLegs,
    nMissedApproachLegs
  }
}

/** Same field shape as an ENROUTE_TRANSITION (NAME, N_APPROACH_LEGS) — reused directly
 *  rather than a duplicate parser. `parseEnrouteTransition`'s name is generic on purpose. */
export const parseApproachTransition = parseEnrouteTransition

/** `TAXI_POINT`'s `BIAS_X`/`BIAS_Z` are metre offsets from the airport's own reference point —
 *  no LATITUDE/LONGITUDE of their own. Axis convention confirmed live 2026-09-28: `BIAS_X` =
 *  metres east, `BIAS_Z` = metres north, true-north aligned, plain flat local tangent plane —
 *  no rotation or magnetic-variance correction needed (docs/navdata-notes.md).
 *
 * @param refLatitude The airport's reference point, degrees.
 * @param refLongitude The airport's reference point, degrees.
 * @param biasX Metres east of it.
 * @param biasZ Metres north of it.
 * @returns The point, in degrees.
 */
export function biasToLatLon(
  refLatitude: number,
  refLongitude: number,
  biasX: number,
  biasZ: number
): { latitude: number; longitude: number } {
  const { lat, lon } = offsetBy({ lat: refLatitude, lon: refLongitude }, biasX, biasZ)
  return { latitude: lat, longitude: lon }
}

/** TAXI_POINT `TYPE` values that mark a hold-short line, per the SDK reference's own enum
 *  (2 HOLD_SHORT, 4 ILS_HOLD_SHORT, 5 HOLD_SHORT_NO_DRAW, 6 ILS_HOLD_SHORT_NO_DRAW). Only 5
 *  has been seen live so far (VHHH, 63 of 4,434 points, 2026-09-30). */
const HOLD_SHORT_TYPES = new Set([2, 4, 5, 6])

export interface ParsedTaxiPoint {
  holdShort: boolean
  biasX: number
  biasZ: number
}

/**
 * Registers the TAXI_POINT records: type and offset from the airport's reference point.
 *
 * @param addField Adds one field to the facility definition being built, in read order.
 */
export function addTaxiPointFields(addField: (name: string) => void): void {
  addField('TYPE')
  addField('BIAS_X')
  addField('BIAS_Z')
}

/**
 * Reads one TAXI_POINT record.
 *
 * @param d The record buffer, positioned at this record.
 * @returns The point's type and offset, in metres.
 */
export function parseTaxiPoint(d: RawBuffer): ParsedTaxiPoint {
  const type = d.readInt32()
  const biasX = d.readFloat32()
  const biasZ = d.readFloat32()
  return { holdShort: HOLD_SHORT_TYPES.has(type), biasX, biasZ }
}

export interface ParsedTaxiPath {
  type: number
  /** Index into the airport's TAXI_POINT list (docs/navdata-notes.md, 2026-09-28: confirmed
   *  this indexes the *unfiltered* point list — TAXI_POINT itself is never filtered, exactly
   *  because filtering it would desync these indices). */
  start: number
  end: number
  /** Index into the airport's TAXI_NAME list, or `null` for index 0 — confirmed live
   *  2026-09-28 to be the real "no name" sentinel, not a missing/error case
   *  (docs/navdata-notes.md). */
  nameIndex: number | null
}

/**
 * Registers the TAXI_PATH records: the two points each joins, its type and its name index.
 *
 * @param addField Adds one field to the facility definition being built, in read order.
 */
export function addTaxiPathFields(addField: (name: string) => void): void {
  addField('TYPE')
  addField('START')
  addField('END')
  addField('NAME_INDEX')
}

/**
 * Reads one TAXI_PATH record.
 *
 * @param d The record buffer, positioned at this record.
 * @returns The path.
 */
export function parseTaxiPath(d: RawBuffer): ParsedTaxiPath {
  const type = d.readInt32()
  const start = d.readInt32()
  const end = d.readInt32()
  const nameIndex = d.readInt32()
  return { type, start, end, nameIndex: nameIndex === 0 ? null : nameIndex }
}

export interface ParsedTaxiName {
  name: string
}

/**
 * Registers the TAXI_NAME records: the taxiway names TAXI_PATH's name index points into.
 *
 * @param addField Adds one field to the facility definition being built, in read order.
 */
export function addTaxiNameFields(addField: (name: string) => void): void {
  addField('NAME')
}

/**
 * Reads one TAXI_NAME record.
 *
 * @param d The record buffer, positioned at this record.
 * @returns The name.
 */
export function parseTaxiName(d: RawBuffer): ParsedTaxiName {
  return { name: d.readString8() }
}

/** One TAXI_PARKING record (stands/gates) — every field confirmed live 2026-10-02
 *  (winglog-backend's docs/navdata-notes.md, "TAXI_PARKING"): positions are BIAS_X/BIAS_Z
 *  like TAXI_POINT's, within 13-15 m of where a real flight parked at VHHH N32 / YBBN gate 79. */
export interface ParsedTaxiParking {
  /** SDK NAME enum: 0 NONE, 1 PARKING, 2-9 N..NW_PARKING, 10 GATE, 11 DOCK, 12-37 GATE_A..Z. */
  nameCode: number
  /** A separate code, often on a second entry with the same NAME+NUMBER (likely a MARS stand's
   *  halves); its letter mapping is unconfirmed, so it's kept raw. */
  suffix: number
  number: number
  headingDeg: number
  biasX: number
  biasZ: number
}

/**
 * Registers the TAXI_PARKING records (stands and gates).
 *
 * @param addField Adds one field to the facility definition being built, in read order.
 */
export function addTaxiParkingFields(addField: (name: string) => void): void {
  addField('NAME')
  addField('SUFFIX')
  addField('NUMBER')
  addField('HEADING')
  addField('BIAS_X')
  addField('BIAS_Z')
}

/**
 * Reads one TAXI_PARKING record.
 *
 * @param d The record buffer, positioned at this record.
 * @returns The stand.
 */
export function parseTaxiParking(d: RawBuffer): ParsedTaxiParking {
  const nameCode = d.readInt32()
  const suffix = d.readInt32()
  const number = d.readUint32()
  const headingDeg = d.readFloat32()
  const biasX = d.readFloat32()
  const biasZ = d.readFloat32()
  return { nameCode, suffix, number, headingDeg, biasX, biasZ }
}

/** The stand's name as ATC says it: GATE_N 32 → "N32" (BeyondATC's "Stand N32", VHHH), and
 *  every other NAME (GATE, PARKING, a compass-point PARKING, DOCK) just the number — "Gate 79"
 *  at YBBN is NAME GATE, NUMBER 79.
 *
 * @param nameCode TAXI_PARKING's NAME value.
 * @param number TAXI_PARKING's NUMBER.
 * @returns The stand as ATC says it, e.g. 'N32' or '79'.
 */
export function standLabel(nameCode: number, number: number): string {
  const letter = nameCode >= 12 && nameCode <= 37 ? String.fromCharCode(65 + nameCode - 12) : ''
  return `${letter}${number}`
}
