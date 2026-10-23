/**
 * The approach WingLog suggests when nothing is chosen yet, as a pure decision (winglog-backend's docs/plans/taxi-and-second-screen-robustness.md,
 * stage 4). SimBrief never plans an approach, so one is picked from the arrival airport's navdata once its list is in, swapped for the one the
 * STAR leads into once the STAR's waypoints are known, and joined to the STAR's last fix by the approach's own transition when one starts there.
 *
 * Two callers use it: the main process, for a saved flight (src/main/tracking/ProcedureSelectionStore.ts), so the choice is made whichever
 * screen is open; and the Dispatch page, for a plan not yet saved as a flight (src/renderer/src/use-default-approach.ts).
 */

import type { NavdataProcedureOption, ProcedureSelection } from './ipc'
import { arrivalAirport, type ProcedureAirports } from './procedure-selection'
import {
  approachConnectingToStar,
  approachRunway,
  parseRouteProcedures,
  pickDefaultApproachIdentifier,
  type Waypoint
} from './route'

/** What the decision looks at. */
export interface ApproachSuggestionInput {
  /** The flight's airports and plan. */
  airports: ProcedureAirports
  /** The selection as it stands. */
  selection: ProcedureSelection
  /** The approaches of the airport the selection's arrival is for, or null before its list is in. */
  options: NavdataProcedureOption[] | null
  /** The ident of the last waypoint of the route's STAR, or null when the route has none. */
  starEnd: string | null
  /** Whether the pilot cleared the approach ("None") for this plan and airport, so it isn't suggested again. */
  cleared: boolean
  /** The approach WingLog itself suggested, which a later look at the STAR may swap; one the pilot chose is never touched. */
  suggested: string | null
}

/** One change to make. */
export interface ApproachSuggestion {
  /** The fields to change on the selection. */
  patch: Partial<ProcedureSelection>
  /** The approach WingLog has suggested once the patch is applied. */
  suggested: string | null
}

/**
 * @param waypoints The assembled route.
 * @returns The ident of the STAR's last waypoint, or null when the route has no STAR.
 */
export function starLastIdent(waypoints: Waypoint[]): string | null {
  return [...waypoints].reverse().find((w) => w.segment === 'star')?.ident ?? null
}

/**
 * @param options A procedure list.
 * @param identifier The procedure.
 * @returns The procedure's named transitions, each once.
 */
export function transitionsFor(options: NavdataProcedureOption[], identifier: string | null): string[] {
  return [
    ...new Set(
      options
        .filter((o) => o.identifier === identifier)
        .map((o) => o.transition)
        .filter((t): t is string => t !== null)
    )
  ]
}

/**
 * The next change to make to the selection, if any. Apply it and ask again until there is none: a pick can be followed by a swap to the
 * approach the STAR leads into and by the transition that joins the two.
 *
 * 1. Nothing chosen: pick an approach, preferring the OFP's planned runway (the filed destination's, not an alternate's) and one the STAR
 *    leads into; none when the pilot cleared it.
 * 2. WingLog's own suggestion that doesn't connect to the STAR: swap it for one that does, as a BeyondATC clearance's approach is checked.
 * 3. An approach with no transition when one is named after the STAR's last fix: start where the STAR ends. A deliberate transition is never
 *    overwritten.
 *
 * @param input The selection and what it is for.
 * @returns The change, or null when there is nothing to do.
 */
export function suggestApproach(input: ApproachSuggestionInput): ApproachSuggestion | null {
  const { airports, selection, options, starEnd, cleared, suggested } = input
  if (!options) return null
  if (!selection.approachIdent) {
    if (cleared || options.length === 0) return null
    const arrIcao = arrivalAirport(airports, selection)
    const plannedRunway =
      arrIcao === airports.arrIcao ? parseRouteProcedures(airports.ofpJson).arrivalRunway : null
    const candidates = plannedRunway
      ? options.filter((o) => approachRunway(o.identifier) === plannedRunway)
      : options
    // Prefer an approach the STAR leads into (ZJSY: UPRS2C ends at SY498, ILS Z 08's entry).
    const pick = pickDefaultApproachIdentifier(candidates, starEnd)
    return pick ? { patch: { approachIdent: pick }, suggested: pick } : null
  }
  if (suggested === selection.approachIdent && starEnd) {
    const swap = approachConnectingToStar(
      options,
      selection,
      approachRunway(selection.approachIdent),
      starEnd
    )
    if (swap) return { patch: swap, suggested: swap.approachIdent }
  }
  if (
    !selection.approachTransition &&
    starEnd &&
    transitionsFor(options, selection.approachIdent).includes(starEnd)
  )
    return { patch: { approachTransition: starEnd }, suggested }
  return null
}
