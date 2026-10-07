/** The SID, STAR and approach selection: seeding it, reading it back, and the live route it draws. */

import { useEffect, useMemo, useState } from 'react'
import type { NavdataLeg, NavdataProcedureKind, ProcedureSelection } from '@shared/ipc'
import {
  applyProcedureSelection,
  approachRunway,
  parseRouteProcedures,
  segmentWaypoints,
  type ProcedureLegs,
  type Waypoint
} from './route'

/** Structural subset both DispatchOfp and Flight satisfy — useLiveWaypoints and
 *  ProcedureSelector only ever need these three fields, whichever kind of object Dispatch
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
 * behaves identically to the old OFP-only rendering: useLiveWaypoints with an empty
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
 * Fetches real navdata legs for whatever's currently selected and assembles the live
 * waypoint list — the single source of truth both Dispatch's preview and Track's map render
 * from, so the two can never disagree (docs/plans/navdata-without-navigraph.md, Phase 5).
 * Every fetch is a local SQLite cache read (navdataGetProcedureWaypoints), not a live sim
 * round-trip, so refetching on every selection change (rather than only when a choice
 * differs from SimBrief's own, the old Phase 3 UI's optimization) is cheap enough to not
 * bother with — simpler code, and it's what lets an unchanged-from-SimBrief selection still
 * go through the exact same path as an overridden one, with no separate case to keep in
 * sync.
 */
/** Identifies which (icao, kind, ident, runway, transition) a fetched legs array answers,
 *  so a resolving fetch can be checked against the *current* selection before it's used —
 *  see useLiveWaypoints's own comment for why this exists. */
interface FetchedLegs {
  key: string
  legs: NavdataLeg[]
}

function legsKey(
  icao: string,
  kind: string,
  ident: string,
  runway: string | null,
  transition: string | null
): string {
  return JSON.stringify([icao, kind, ident, runway, transition])
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

/**
 * The fetched legs to splice in for a procedure, or null to keep SimBrief's own segment.
 *
 * `legs.length > 0`, not just the identifier being set, gates each splice — an
 * identifier whose fetch hasn't resolved yet, or whose legs come back genuinely empty
 * (navdata not yet refreshed for this airport, or a naming mismatch between SimBrief's
 * own SID/STAR name and the sim's), must fall back to SimBrief's own base segment
 * rather than rendering a gap where that segment used to be. Only the SID/STAR base
 * has anything to fall back to — an approach with no legs yet just contributes nothing,
 * same as no approach chosen at all. The key check on top of that refuses a resolved
 * fetch that no longer matches the current selection, rather than rendering it stale.
 *
 * @param identifier The selected procedure.
 * @param key The key of the legs it needs.
 * @param fetched The latest fetched legs, or null.
 * @returns The legs, or null.
 */
function matchingLegs(identifier: string, key: string, fetched: FetchedLegs | null): ProcedureLegs | null {
  return fetched?.key === key && fetched.legs.length > 0 ? { identifier, legs: fetched.legs } : null
}

/**
 * Fetches one procedure's legs, tagged with the arguments they were fetched for (legsKey).
 * An empty list stands in for a failed fetch.
 *
 * @param args The airport, kind, procedure, runway and transition.
 * @param set Receives the legs, unless the returned cleanup ran first.
 * @returns The effect cleanup: a fetch still in flight is then ignored.
 */
function fetchProcedureLegs(
  args: [string, NavdataProcedureKind, string, string | null, string | null],
  set: (fetched: FetchedLegs) => void
): () => void {
  let ignore = false
  const key = legsKey(...args)
  window.winglog
    .navdataGetProcedureWaypoints(...args)
    .then((legs) => {
      if (!ignore) set({ key, legs })
    })
    .catch(() => {
      if (!ignore) set({ key, legs: [] })
    })
  return () => {
    ignore = true
  }
}

/**
 * SimBrief's route with each selected procedure's fetched legs spliced in, where they match
 * the current selection (see matchingLegs).
 *
 * @param airports The flight's airports and OFP.
 * @param selection The selection.
 * @param fetched The latest fetched legs of each kind.
 * @returns The route's waypoints.
 */
function splicedRoute(
  airports: ProcedureAirports,
  selection: ProcedureSelection,
  fetched: { sid: FetchedLegs | null; star: FetchedLegs | null; approach: FetchedLegs | null }
): Waypoint[] {
  const {
    sidIdent,
    departureRunway,
    sidTransition,
    starIdent,
    starTransition,
    approachIdent,
    approachTransition
  } = selection
  const base = segmentWaypoints(airports.ofpJson)
  const arrIcao = arrivalAirport(airports, selection)
  const sid = sidIdent
    ? matchingLegs(
        sidIdent,
        legsKey(airports.depIcao, 'sid', sidIdent, departureRunway, sidTransition),
        fetched.sid
      )
    : null
  const starRunway = approachRunway(approachIdent)
  const star = starIdent
    ? matchingLegs(starIdent, legsKey(arrIcao, 'star', starIdent, starRunway, starTransition), fetched.star)
    : null
  const approach = approachIdent
    ? matchingLegs(
        approachIdent,
        legsKey(arrIcao, 'approach', approachIdent, null, approachTransition),
        fetched.approach
      )
    : null
  // Diverting: the filed destination's own STAR no longer applies.
  return applyProcedureSelection(base, sid, star, approach, {
    alternateArrival: arrIcao !== airports.arrIcao
  })
}

/**
 * The route to draw: SimBrief's, with the selected procedures' legs fetched from navdata and spliced in.
 *
 * @param airports The flight's airports and OFP, or null.
 * @param selection The selection.
 * @returns The route's waypoints with the selected procedures spliced in.
 */
export function useLiveWaypoints(
  airports: ProcedureAirports | null,
  selection: ProcedureSelection
): Waypoint[] {
  const {
    sidIdent,
    departureRunway,
    sidTransition,
    starIdent,
    starTransition,
    approachIdent,
    approachTransition,
    arrivalIcao
  } = selection
  const [sidLegs, setSidLegs] = useState<FetchedLegs | null>(null)
  const [starLegs, setStarLegs] = useState<FetchedLegs | null>(null)
  const [approachLegs, setApproachLegs] = useState<FetchedLegs | null>(null)

  // None of the three effects below reset their legs state when the corresponding
  // identifier goes null — deliberately: the assembly below only ever reads sidLegs/
  // starLegs/approachLegs when its identifier is non-null, so a stale array left over from
  // a previous selection is inert, never rendered. Matches the pattern already established
  // in this codebase for the same reason (DispatchView's original Phase 3 effects).
  //
  // Each effect also guards against out-of-order resolution: `ignore` (set in the cleanup)
  // stops a stale fetch from calling setXLegs after a newer one has started, and the stored
  // result is tagged with the exact arguments it was fetched for so the assembly below can
  // refuse to use it once the selection has moved on but the fetch hasn't resolved yet.
  // Real case this closes: ProcedureSelector auto-picks an approach once navdata loads, so a
  // STAR fetch with `runway = null` can still be in flight when the auto-pick starts a
  // second one with the approach's real runway — without this, whichever resolves last wins
  // even if it's the stale one.
  useEffect(() => {
    if (!airports || !sidIdent) return
    return fetchProcedureLegs([airports.depIcao, 'sid', sidIdent, departureRunway, sidTransition], setSidLegs)
  }, [airports, sidIdent, departureRunway, sidTransition])

  useEffect(() => {
    if (!airports || !starIdent) return
    // A STAR's real legs can live inside a runway-specific transition (VHHH's STARs do) —
    // there's no separate arrival-runway selection any more, so the currently-chosen
    // approach's own runway (encoded in its identifier) is what filters this.
    const runway = approachRunway(approachIdent)
    const arrIcao = arrivalAirport(airports, { arrivalIcao })
    return fetchProcedureLegs([arrIcao, 'star', starIdent, runway, starTransition], setStarLegs)
  }, [airports, starIdent, starTransition, approachIdent, arrivalIcao])

  useEffect(() => {
    if (!airports || !approachIdent) return
    const arrIcao = arrivalAirport(airports, { arrivalIcao })
    return fetchProcedureLegs([arrIcao, 'approach', approachIdent, null, approachTransition], setApproachLegs)
  }, [airports, approachIdent, approachTransition, arrivalIcao])

  // Memoized so callers that key their own effects off this result (e.g. LogbookView's
  // great-circle-fallback check) see a stable reference across renders that don't actually
  // change anything here, not a fresh array every time.
  return useMemo(
    () =>
      airports
        ? splicedRoute(
            airports,
            {
              sidIdent,
              departureRunway,
              sidTransition,
              starIdent,
              starTransition,
              approachIdent,
              approachTransition,
              arrivalIcao
            },
            { sid: sidLegs, star: starLegs, approach: approachLegs }
          )
        : [],
    [
      airports,
      sidIdent,
      departureRunway,
      sidTransition,
      starIdent,
      starTransition,
      approachIdent,
      approachTransition,
      arrivalIcao,
      sidLegs,
      starLegs,
      approachLegs
    ]
  )
}
