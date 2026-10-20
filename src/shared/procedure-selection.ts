/**
 * The SID, STAR and approach selection, and the route it draws: seeding it, reading it back, which procedure legs the route needs and
 * putting them together. Shared by the renderer (which fetches the legs over IPC) and the main process (which reads them from its
 * navdata cache and pushes the finished route to a second screen; winglog-backend's docs/plans/lan-sync.md).
 */

import type { AtcClearanceUpdate } from './atc-info-boxes'
import type { NavdataLeg, NavdataProcedureKind, ProcedureSelection } from './ipc'
import {
  applyProcedureSelection,
  approachRunway,
  parseRouteProcedures,
  segmentWaypoints,
  type ProcedureLegs,
  type Waypoint
} from './route'

/** Structural subset both DispatchOfp and Flight satisfy: the route only ever needs these fields, whichever kind of object Dispatch
 *  or Track happens to be looking at. */
export interface ProcedureAirports {
  depIcao: string
  arrIcao: string
  /** The plan's alternate, when there is one — the Procedures dialog can switch its arrival
   *  dropdowns to it for a diversion (v1.1.1). */
  altnIcao?: string | null
  ofpJson: string | null
}

/**
 * A selection with nothing chosen.
 *
 * @returns A selection with every field null.
 */
export function emptyProcedureSelection(): ProcedureSelection {
  return {
    departureRunway: null,
    sidIdent: null,
    sidTransition: null,
    starIdent: null,
    starTransition: null,
    approachIdent: null,
    approachTransition: null,
    arrivalIcao: null
  }
}

/**
 * Seeds a fresh selection from SimBrief's own stated choice — approachIdent/
 * approachTransition start null regardless, since SimBrief never plans an approach at all
 * (ProcedureSelector auto-picks one once real navdata loads, see its own doc comment).
 *
 * @param ofpJson The flight's OFP JSON, or null.
 * @returns The selection SimBrief planned.
 */
export function seedProcedureSelectionFromOfp(ofpJson: string | null): ProcedureSelection {
  const p = parseRouteProcedures(ofpJson)
  return {
    departureRunway: p.departureRunway,
    sidIdent: p.sidIdent,
    sidTransition: p.sidTransition,
    starIdent: p.starIdent,
    starTransition: p.starTransition,
    approachIdent: null,
    approachTransition: null,
    arrivalIcao: null
  }
}

/**
 * Reads a completed flight's persisted selection back out — Logbook's map shows what was
 * actually flown, not just SimBrief's original plan, when Track ever pushed one (Phase 5).
 * All-null is a legitimate value (a pre-Phase-5 flight, or nothing was ever touched) and
 * behaves identically to the old OFP-only rendering: the live route with an empty
 * selection reduces to plain segmentWaypoints, the same function the old
 * parseWaypointsFromOfpJson called.
 *
 * @param flight The flight's stored selection columns.
 * @returns The selection.
 */
export function selectionFromFlight(flight: {
  selectedDepartureRunway: string | null
  selectedSidIdent: string | null
  selectedSidTransition: string | null
  selectedStarIdent: string | null
  selectedStarTransition: string | null
  selectedApproachIdent: string | null
  selectedApproachTransition: string | null
  selectedArrivalIcao?: string | null
}): ProcedureSelection {
  return {
    departureRunway: flight.selectedDepartureRunway,
    sidIdent: flight.selectedSidIdent,
    sidTransition: flight.selectedSidTransition,
    starIdent: flight.selectedStarIdent,
    starTransition: flight.selectedStarTransition,
    approachIdent: flight.selectedApproachIdent,
    approachTransition: flight.selectedApproachTransition,
    arrivalIcao: flight.selectedArrivalIcao ?? null
  }
}

/**
 * The airport the STAR/approach are for: the filed destination, or the alternate when the
 * pilot switched to it.
 *
 * @param airports The flight's airports.
 * @param selection The selection (only its `arrivalIcao` is read).
 * @returns The arrival airport's ICAO code.
 */
export function arrivalAirport(
  airports: ProcedureAirports,
  selection: Pick<ProcedureSelection, 'arrivalIcao'>
): string {
  return selection.arrivalIcao ?? airports.arrIcao
}

/** The arguments of one procedure's legs lookup. */
export interface ProcedureRequest {
  icao: string
  kind: NavdataProcedureKind
  identifier: string
  runway: string | null
  transition: string | null
}

/** The lookups the selected procedures need, each null when that procedure isn't selected. */
export interface ProcedureRequests {
  sid: ProcedureRequest | null
  star: ProcedureRequest | null
  approach: ProcedureRequest | null
}

/**
 * Which legs lookups the selection needs. A STAR's real legs can live inside a runway-specific transition (VHHH's STARs do), and
 * there is no separate arrival-runway selection, so the chosen approach's own runway filters it.
 *
 * @param airports The flight's airports.
 * @param selection The selection.
 * @returns The SID at the departure with its runway and transition, the STAR and approach at the arrival airport; null for each not selected.
 */
export function procedureRequests(
  airports: ProcedureAirports,
  selection: ProcedureSelection
): ProcedureRequests {
  const arrIcao = arrivalAirport(airports, selection)
  return {
    sid: selection.sidIdent
      ? {
          icao: airports.depIcao,
          kind: 'sid',
          identifier: selection.sidIdent,
          runway: selection.departureRunway,
          transition: selection.sidTransition
        }
      : null,
    star: selection.starIdent
      ? {
          icao: arrIcao,
          kind: 'star',
          identifier: selection.starIdent,
          runway: approachRunway(selection.approachIdent),
          transition: selection.starTransition
        }
      : null,
    approach: selection.approachIdent
      ? {
          icao: arrIcao,
          kind: 'approach',
          identifier: selection.approachIdent,
          runway: null,
          transition: selection.approachTransition
        }
      : null
  }
}

/**
 * The legs fetched for each lookup, or null where none has arrived (or the one that did is for a selection since changed).
 */
export interface FetchedProcedureLegs {
  sid: NavdataLeg[] | null
  star: NavdataLeg[] | null
  approach: NavdataLeg[] | null
}

/**
 * @param identifier The selected procedure.
 * @param legs Its fetched legs, or null.
 * @returns The legs to splice in, or null to keep SimBrief's own segment. `legs.length > 0`, not just the identifier being set, gates
 *   each splice: legs that come back empty (navdata not yet refreshed for this airport, or a naming mismatch between SimBrief's own
 *   SID/STAR name and the sim's) must fall back to SimBrief's own base segment rather than rendering a gap. Only the SID/STAR base
 *   has anything to fall back to; an approach with no legs just contributes nothing, same as no approach chosen.
 */
function usableLegs(identifier: string | null, legs: NavdataLeg[] | null): ProcedureLegs | null {
  return identifier && legs && legs.length > 0 ? { identifier, legs } : null
}

/**
 * SimBrief's route with each selected procedure's fetched legs spliced in.
 *
 * @param airports The flight's airports and OFP.
 * @param selection The selection.
 * @param fetched The legs fetched for each lookup that applies.
 * @returns The route's waypoints.
 */
export function assembleRoute(
  airports: ProcedureAirports,
  selection: ProcedureSelection,
  fetched: FetchedProcedureLegs
): Waypoint[] {
  return applyProcedureSelection(
    segmentWaypoints(airports.ofpJson),
    usableLegs(selection.sidIdent, fetched.sid),
    usableLegs(selection.starIdent, fetched.star),
    usableLegs(selection.approachIdent, fetched.approach),
    // Diverting: the filed destination's own STAR no longer applies.
    { alternateArrival: arrivalAirport(airports, selection) !== airports.arrIcao }
  )
}

/**
 * The selection after the pilot accepts a clearance. A procedure that changes drops the old one's transition, as choosing it in
 * the selector does: the old transition belongs to the old procedure, and asking navdata for the new one with it finds no legs,
 * so the map would keep drawing the old route.
 *
 * @param selection The current procedure selection.
 * @param fields The clearance's fields.
 * @returns The selection with the clearance applied.
 */
export function applyClearance(
  selection: ProcedureSelection,
  fields: AtcClearanceUpdate['fields']
): ProcedureSelection {
  const next = { ...selection, ...fields }
  if (fields.sidIdent !== undefined && fields.sidIdent !== selection.sidIdent) next.sidTransition = null
  if (fields.starIdent !== undefined && fields.starIdent !== selection.starIdent) next.starTransition = null
  if (
    fields.approachIdent !== undefined &&
    fields.approachIdent !== selection.approachIdent &&
    fields.approachTransition === undefined
  ) {
    next.approachTransition = null
  }
  return next
}
