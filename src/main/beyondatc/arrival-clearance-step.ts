/**
 * The arrival clearance as a pure step function (coding-standards.md §10): `(state, input) → state`,
 * with the navdata lookups passed in. `ArrivalClearanceTracker` is the thin wrapper that holds the
 * state and emits; the offline simulation replays recorded InfoBoxes through this same code.
 */
import type { BeyondAtcArrivalClearance, BeyondAtcInfoBox, FlightPhase, NavdataProcedureOption } from '@shared/ipc'
import { matchClearanceApproach } from '@shared/atc-approach-match'
import { parseAtcBoxClearance, type AtcClearanceUpdate } from '@shared/atc-info-boxes'

/** What the step needs to look up. */
export interface ArrivalLookup {
  /** The airport being flown to: the active flight's arrival, else BeyondATC's own route. */
  getArrivalIcao(): string | null
  /** The airport's approaches from navdata, to name a cleared approach the way the sim does. */
  listApproaches(icao: string): NavdataProcedureOption[]
}

/** The card, and the last InfoBox set read (so an unchanged set is read once). */
export interface ArrivalState {
  clearance: BeyondAtcArrivalClearance | null
  lastBoxesKey: string
}

/** What can happen to the card. */
export type ArrivalInput = { kind: 'boxes'; boxes: BeyondAtcInfoBox[] } | { kind: 'phase'; phase: FlightPhase }

/** A flight with nothing cleared yet. */
export const INITIAL_ARRIVAL_STATE: ArrivalState = { clearance: null, lastBoxesKey: '' }

/**
 * One step: reads a new set of InfoBoxes (once), or clears the card at touchdown.
 *
 * @param state The card and the last boxes read.
 * @param input A new InfoBox set, or the tracked flight's phase.
 * @param lookup Navdata lookups, to name a cleared approach the sim's way.
 * @returns The state after. The same `clearance` object when nothing changed, so a caller can compare by identity.
 */
export function stepArrival(state: ArrivalState, input: ArrivalInput, lookup: ArrivalLookup): ArrivalState {
  if (input.kind === 'phase') {
    return input.phase === 'landing' ? withClearance(state, null) : state
  }
  const key = JSON.stringify(input.boxes)
  if (key === state.lastBoxesKey) return state
  const read: ArrivalState = { ...state, lastBoxesKey: key }
  const parsed = parseAtcBoxClearance(input.boxes)
  return parsed ? withClearance(read, applyBoxes(state.clearance, parsed, lookup)) : read
}

/**
 * The state with a new card, unchanged when the card is the same.
 *
 * @param state The state now.
 * @param next The card after.
 * @returns The state after.
 */
function withClearance(state: ArrivalState, next: BeyondAtcArrivalClearance | null): ArrivalState {
  return JSON.stringify(next) === JSON.stringify(state.clearance) ? state : { ...state, clearance: next }
}

/**
 * The card after one parsed set of boxes.
 *
 * @param current The card now, or null.
 * @param parsed What the boxes clear.
 * @param lookup Navdata lookups.
 * @returns The card after.
 */
function applyBoxes(
  current: BeyondAtcArrivalClearance | null,
  parsed: AtcClearanceUpdate,
  lookup: ArrivalLookup
): BeyondAtcArrivalClearance | null {
  const { starIdent, approachIdent } = parsed.fields
  if (starIdent) return withStar(current, starIdent, parsed.arrivalRunway ?? null)
  if (approachIdent) return withApproach(current, parsed, approachIdent, lookup)
  if (parsed.arrivalRunway) return withRunway(current, parsed.arrivalRunway, parsed.fields.approachTransition)
  return current
}

/**
 * `STAR` + `Arrival Runway`: a known approach is kept only if it's for that runway.
 *
 * @param current The card now, or null.
 * @param starIdent The STAR cleared.
 * @param runway The runway cleared with it, or null.
 * @returns The card after.
 */
function withStar(current: BeyondAtcArrivalClearance | null, starIdent: string, runway: string | null): BeyondAtcArrivalClearance {
  const kept = runway !== null && current?.approachIdent != null && current.approachIdent.endsWith(` ${runway}`) ? current : null
  return { starIdent, runway, approachIdent: kept?.approachIdent ?? null, approachTransition: kept?.approachTransition ?? null }
}

/**
 * `Cleared Approach`: named the way the airport's navdata names it, and a transition already known for that approach (or the
 * first one named on the briefed runway) kept.
 *
 * @param current The card now, or null.
 * @param parsed What the boxes clear.
 * @param approachIdent The approach as ATC named it.
 * @param lookup Navdata lookups.
 * @returns The card after.
 */
function withApproach(
  current: BeyondAtcArrivalClearance | null,
  parsed: AtcClearanceUpdate,
  approachIdent: string,
  lookup: ArrivalLookup
): BeyondAtcArrivalClearance {
  const named = navdataNamed(parsed, lookup)
  const ident = named.fields.approachIdent ?? approachIdent
  // The briefing's `Transition` can come minutes before `Cleared Approach`.
  const briefed = current?.approachIdent == null && current?.runway != null && ident.endsWith(` ${current.runway}`)
  const keepsTransition = current !== null && (current.approachIdent === ident || briefed)
  return {
    starIdent: current?.starIdent ?? null,
    runway: current?.runway ?? null,
    approachIdent: ident,
    approachTransition: named.fields.approachTransition ?? (keepsTransition ? current.approachTransition : null)
  }
}

/**
 * The cleared approach as the airport's navdata names it, when navdata has it.
 *
 * @param parsed What the boxes clear.
 * @param lookup Navdata lookups.
 * @returns The navdata match, or the boxes' own wording.
 */
function navdataNamed(parsed: AtcClearanceUpdate, lookup: ArrivalLookup): AtcClearanceUpdate {
  const icao = lookup.getArrivalIcao()
  const matched = icao ? matchClearanceApproach(parsed, lookup.listApproaches(icao)) : null
  return matched?.fields.approachIdent ? matched : parsed
}

/**
 * `Landing Runway` on its own, maybe with the approach transition: an approach for another runway no longer applies.
 *
 * @param current The card now, or null.
 * @param runway The runway cleared.
 * @param approachTransition The transition cleared with it, if any.
 * @returns The card after.
 */
function withRunway(
  current: BeyondAtcArrivalClearance | null,
  runway: string,
  approachTransition: string | null | undefined
): BeyondAtcArrivalClearance {
  const kept = current?.approachIdent != null && current.approachIdent.endsWith(` ${runway}`) ? current : null
  return {
    starIdent: current?.starIdent ?? null,
    runway,
    approachIdent: kept?.approachIdent ?? null,
    approachTransition: approachTransition ?? kept?.approachTransition ?? null
  }
}
