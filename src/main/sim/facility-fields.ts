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
 * Deliberately out of scope here: APPROACH/APPROACH_TRANSITION/FINAL_APPROACH_LEG/
 * MISSED_APPROACH_LEG (approach procedures, not needed by the six SID/STAR/runway dropdowns
 * this provider serves), and — separately, and worth flagging — the legs *inside* a
 * RUNWAY_TRANSITION or ENROUTE_TRANSITION. The spike only ever registered `N_APPROACH_LEGS`
 * (a count) on those two, never a nested `OPEN APPROACH_LEG`/`CLOSE APPROACH_LEG` block
 * inside them, so whether MSFS's facility API actually supports fetching a transition's own
 * legs that way is genuinely unconfirmed, not just unbuilt. `getProcedureWaypoints` below
 * only returns the procedure's own common legs (the DEPARTURE/ARRIVAL-level `APPROACH_LEG`
 * list, which the spike did fetch and observe correctly) until a follow-up spike confirms
 * the nested form.
 */

export const enum NavdataDefId {
  RUNWAYS = 10,
  DEPARTURES = 11,
  ARRIVALS = 12
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
  add('CLOSE RUNWAY_TRANSITION')
  add('OPEN ENROUTE_TRANSITION')
  add('NAME')
  add('N_APPROACH_LEGS')
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
