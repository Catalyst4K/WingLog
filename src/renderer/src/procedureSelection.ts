import { useEffect, useMemo, useState } from 'react'
import type { NavdataLeg, ProcedureSelection } from '@shared/ipc'
import { applyProcedureSelection, approachRunway, parseRouteProcedures, segmentWaypoints, type Waypoint } from './route'

/** Structural subset both DispatchOfp and Flight satisfy — useLiveWaypoints and
 *  ProcedureSelector only ever need these three fields, whichever kind of object Dispatch
 *  or Track happens to be looking at. */
export interface ProcedureAirports {
  depIcao: string
  arrIcao: string
  ofpJson: string | null
}

export function emptyProcedureSelection(): ProcedureSelection {
  return {
    departureRunway: null,
    sidIdent: null,
    sidTransition: null,
    starIdent: null,
    starTransition: null,
    approachIdent: null,
    approachTransition: null
  }
}

/** Seeds a fresh selection from SimBrief's own stated choice — approachIdent/
 *  approachTransition start null regardless, since SimBrief never plans an approach at all
 *  (ProcedureSelector auto-picks one once real navdata loads, see its own doc comment). */
export function seedProcedureSelectionFromOfp(ofpJson: string | null): ProcedureSelection {
  const p = parseRouteProcedures(ofpJson)
  return {
    departureRunway: p.departureRunway,
    sidIdent: p.sidIdent,
    sidTransition: p.sidTransition,
    starIdent: p.starIdent,
    starTransition: p.starTransition,
    approachIdent: null,
    approachTransition: null
  }
}

/** Reads a completed flight's persisted selection back out — Logbook's map shows what was
 *  actually flown, not just SimBrief's original plan, when Track ever pushed one (Phase 5).
 *  All-null is a legitimate value (a pre-Phase-5 flight, or nothing was ever touched) and
 *  behaves identically to the old OFP-only rendering: useLiveWaypoints with an empty
 *  selection reduces to plain segmentWaypoints, the same function the old
 *  parseWaypointsFromOfpJson called. */
export function selectionFromFlight(flight: {
  selectedDepartureRunway: string | null
  selectedSidIdent: string | null
  selectedSidTransition: string | null
  selectedStarIdent: string | null
  selectedStarTransition: string | null
  selectedApproachIdent: string | null
  selectedApproachTransition: string | null
}): ProcedureSelection {
  return {
    departureRunway: flight.selectedDepartureRunway,
    sidIdent: flight.selectedSidIdent,
    sidTransition: flight.selectedSidTransition,
    starIdent: flight.selectedStarIdent,
    starTransition: flight.selectedStarTransition,
    approachIdent: flight.selectedApproachIdent,
    approachTransition: flight.selectedApproachTransition
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
export function useLiveWaypoints(airports: ProcedureAirports | null, selection: ProcedureSelection): Waypoint[] {
  const [sidLegs, setSidLegs] = useState<NavdataLeg[]>([])
  const [starLegs, setStarLegs] = useState<NavdataLeg[]>([])
  const [approachLegs, setApproachLegs] = useState<NavdataLeg[]>([])

  // None of the three effects below reset their legs state when the corresponding
  // identifier goes null — deliberately: the assembly below only ever reads sidLegs/
  // starLegs/approachLegs when its identifier is non-null, so a stale array left over from
  // a previous selection is inert, never rendered. Matches the pattern already established
  // in this codebase for the same reason (DispatchView's original Phase 3 effects).
  useEffect(() => {
    if (!airports || !selection.sidIdent) return
    window.winglog
      .navdataGetProcedureWaypoints(airports.depIcao, 'sid', selection.sidIdent, selection.departureRunway, selection.sidTransition)
      .then(setSidLegs)
      .catch(() => setSidLegs([]))
  }, [airports, selection.sidIdent, selection.departureRunway, selection.sidTransition])

  useEffect(() => {
    if (!airports || !selection.starIdent) return
    // A STAR's real legs can live inside a runway-specific transition (VHHH's STARs do) —
    // there's no separate arrival-runway selection any more, so the currently-chosen
    // approach's own runway (encoded in its identifier) is what filters this.
    const runway = approachRunway(selection.approachIdent)
    window.winglog
      .navdataGetProcedureWaypoints(airports.arrIcao, 'star', selection.starIdent, runway, selection.starTransition)
      .then(setStarLegs)
      .catch(() => setStarLegs([]))
  }, [airports, selection.starIdent, selection.starTransition, selection.approachIdent])

  useEffect(() => {
    if (!airports || !selection.approachIdent) return
    window.winglog
      .navdataGetProcedureWaypoints(airports.arrIcao, 'approach', selection.approachIdent, null, selection.approachTransition)
      .then(setApproachLegs)
      .catch(() => setApproachLegs([]))
  }, [airports, selection.approachIdent, selection.approachTransition])

  // Memoized so callers that key their own effects off this result (e.g. LogbookView's
  // great-circle-fallback check) see a stable reference across renders that don't actually
  // change anything here, not a fresh array every time.
  return useMemo(() => {
    if (!airports) return []
    const base = segmentWaypoints(airports.ofpJson)
    // `legs.length > 0`, not just the identifier being set, gates each splice — an
    // identifier whose fetch hasn't resolved yet, or whose legs come back genuinely empty
    // (navdata not yet refreshed for this airport, or a naming mismatch between SimBrief's
    // own SID/STAR name and the sim's), must fall back to SimBrief's own base segment
    // rather than rendering a gap where that segment used to be. Only the SID/STAR base
    // has anything to fall back to — an approach with no legs yet just contributes nothing,
    // same as no approach chosen at all.
    return applyProcedureSelection(
      base,
      selection.sidIdent && sidLegs.length > 0 ? { identifier: selection.sidIdent, legs: sidLegs } : null,
      selection.starIdent && starLegs.length > 0 ? { identifier: selection.starIdent, legs: starLegs } : null,
      selection.approachIdent && approachLegs.length > 0 ? { identifier: selection.approachIdent, legs: approachLegs } : null
    )
  }, [airports, selection.sidIdent, selection.starIdent, selection.approachIdent, sidLegs, starLegs, approachLegs])
}
