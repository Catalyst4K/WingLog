import { type RawBuffer } from 'node-simconnect'

/**
 * Facility Data Definition field names and record parsing for the navdata provider
 * (src/main/navdata/) — kept in src/main/sim/ next to simvars.ts, per CLAUDE.md's "SimVar/
 * facility names live in one place" rule. Field lists and read order are sim-confirmed
 * live, 2026-09-08 (flightdeck-backend's docs/navdata-notes.md, scripts/spike-facilities.ts
 * — same spike, reused here) against a real MSFS 2024: RUNWAY, DEPARTURE/ARRIVAL,
 * RUNWAY_TRANSITION, ENROUTE_TRANSITION and APPROACH_LEG record shapes all match what that
 * spike observed. Registration order = buffer read order, exactly like simvars.ts.
 *
 * APPROACH/APPROACH_TRANSITION/FINAL_APPROACH_LEG parsing added 2026-09-08 for
 * flightdeck-backend's navdata-without-navigraph.md Phase 5 (real approach selection) —
 * spike-confirmed live the same day against a real MSFS 2024 session
 * (flightdeck-backend's docs/navdata-notes.md, "approach procedures, previously out of
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

export const enum NavdataDefId {
  RUNWAYS = 10,
  DEPARTURES = 11,
  ARRIVALS = 12,
  APPROACHES = 13
}

/** 0/1/2/3 = none/L/R/C — confirmed against two real airports with known real layouts
 *  (EGLL: designators 1/2 only, no C; VHHH: 1/2/3, its real three-runway system) —
 *  docs/navdata-notes.md. */
const RUNWAY_DESIGNATORS = ['', 'L', 'R', 'C'] as const

export function runwayIdent(number: number, designator: number): string {
  const suffix = RUNWAY_DESIGNATORS[designator] ?? ''
  return `${String(number).padStart(2, '0')}${suffix}`
}

export interface ParsedAirportHeader {
  icao: string
}

export function addAirportIcaoField(addField: (name: string) => void): void {
  addField('OPEN AIRPORT')
  addField('ICAO')
}

export function parseAirportHeader(d: RawBuffer): ParsedAirportHeader {
  return { icao: d.readString8() }
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
}

const FIX_TYPE_CODES: Record<number, ParsedLeg['fixType']> = { 87: 'W', 86: 'V', 78: 'N', 82: 'R' }

/** Shared field list — identical layout for every leg-bearing struct (APPROACH_LEG,
 *  FINAL_APPROACH_LEG, MISSED_APPROACH_LEG all share it per the MSFS 2024 SDK reference;
 *  only APPROACH_LEG is actually registered here, see the module doc comment). */
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
}

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
    speedLimit
  }
}

/** Builds the full DEPARTURE/ARRIVAL facility definition on `defId` — the airport header,
 *  the procedure header, runway/enroute transition summaries, and the procedure's own
 *  common leg list. Reused for both kinds, since DEPARTURE/ARRIVAL share the same shape. */
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

export function parseProcedureHeader(d: RawBuffer): ParsedProcedureHeader {
  return {
    name: d.readString8(),
    nRunwayTransitions: d.readInt32(),
    nEnrouteTransitions: d.readInt32(),
    nApproachLegs: d.readInt32()
  }
}

export function parseRunwayTransition(d: RawBuffer): ParsedRunwayTransition {
  const runwayNumber = d.readInt32()
  const runwayDesignator = d.readInt32()
  const nApproachLegs = d.readInt32()
  return { runwayIdent: runwayIdent(runwayNumber, runwayDesignator), nApproachLegs }
}

export function parseEnrouteTransition(d: RawBuffer): ParsedEnrouteTransition {
  return { name: d.readString8(), nApproachLegs: d.readInt32() }
}

/** `APPROACH.TYPE`'s raw integer, mapped with confidence — cross-validated against real
 *  EGLL/VHHH approach counts rather than an authoritative SDK table (none found), 2026-09-08
 *  (flightdeck-backend's docs/navdata-notes.md): every runway end at both airports had
 *  exactly one `type=4` and, where present, exactly one `type=5`, matching real published
 *  ILS + LOC-only-backup pairs; `type=10` was the only one ever duplicated per runway,
 *  matching real "RNP Y"/"RNP Z" pairs (confirmed via SUFFIX on VHHH 07R's two `type=10`
 *  approaches). An unrecognized code falls back to its own raw number rather than a made-up
 *  label — better to show "TYPE 7" than silently mislabel something as ILS. */
const APPROACH_TYPE_LABELS: Record<number, string> = { 4: 'ILS', 5: 'LOC', 10: 'RNAV' }

function approachTypeLabel(type: number): string {
  return APPROACH_TYPE_LABELS[type] ?? `TYPE ${type}`
}

/** `APPROACH.SUFFIX`'s raw integer is the ASCII code of the approach's letter suffix (or
 *  '0' for none) — confirmed clean 2026-09-08: 32/40 approaches seen had no suffix, the rest
 *  were 'Y'/'Z'. Falls back to the raw character for anything outside that observed set
 *  rather than assuming — the encoding itself (ASCII code of a single char) is confirmed,
 *  just not every value it can take. */
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
