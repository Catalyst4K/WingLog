/**
 * The rules for keeping a second screen's procedure choice in step with the PC (winglog-backend's docs/plans/lan-sync.md, step 2).
 * The PC owns the choice: each route it pushes carries the choice it was built from and a revision that only goes up. A choice made
 * on this screen counts as made once a route built from it comes back, and is sent again until it does. Pure, so every case is
 * tested away from React and timers.
 */

import type { ProcedureSelection } from '@shared/ipc'
import type { PlannedRoute } from '@shared/live'

/** How long a choice waits for the PC to confirm it before it is sent again, in milliseconds. */
export const CONFIRM_MS = 3000
/** How long the notice that a choice could not be confirmed stays up, in milliseconds. */
export const NOTICE_MS = 8000
/** How many times a choice is sent before the screen gives up on it. */
export const MAX_ATTEMPTS = 3

/** A choice made here that the PC has not yet confirmed. */
export interface PendingChoice {
  selection: ProcedureSelection
  /** How many times it has been sent. */
  attempts: number
}

/** What the screen knows about the choice. */
export interface ChoiceState {
  /** The choice shown. */
  selection: ProcedureSelection
  /** The revision of the last PC route applied, 0 before any. */
  applied: number
  pending: PendingChoice | null
  /** True after a choice was given up on, until the next one is made. */
  unconfirmed: boolean
}

/**
 * @param selection The choice the flight has when the screen starts.
 * @returns The state with nothing pending.
 */
export function initialChoice(selection: ProcedureSelection): ChoiceState {
  return { selection, applied: 0, pending: null, unconfirmed: false }
}

const same = (a: ProcedureSelection, b: ProcedureSelection): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

/**
 * The pilot chooses on this screen: shown at once, and waiting for the PC to confirm. The caller sends it.
 *
 * @param state The state.
 * @param next The new choice.
 * @returns The state with the choice shown and pending, on its first send; unchanged when it is the choice already shown.
 */
export function choose(state: ChoiceState, next: ProcedureSelection): ChoiceState {
  if (same(state.selection, next)) return state
  return { ...state, selection: next, pending: { selection: next, attempts: 1 }, unconfirmed: false }
}

/**
 * A route arrives from the PC for the flight shown.
 * - Nothing pending: it is applied when it is newer than the last one (a change made in the PC's window, by another device, or by a
 *   BeyondATC prompt there).
 * - The pending choice, built into a route: that is the confirmation. It is applied and nothing is pending.
 * - Pending, and the route is for another choice: ignored. It is the echo of an earlier choice, or another screen's, and this screen's
 *   will overwrite it (the PC keeps the last one it hears).
 * - Never one at or below the revision already applied.
 *
 * @param state The state.
 * @param route The route the PC sent.
 * @returns The state after it.
 */
export function receiveRoute(state: ChoiceState, route: PlannedRoute): ChoiceState {
  if (route.revision <= state.applied) return state
  if (state.pending && !same(state.pending.selection, route.selection)) return state
  return { ...state, selection: route.selection, applied: route.revision, pending: null }
}

/**
 * The link to the PC came back. Revisions are only comparable within one connection to the PC (it may have restarted), so the count
 * starts again; the choice still waiting is sent at once and counts as an attempt.
 *
 * @param state The state.
 * @returns The state, and the choice to send now (null when none is waiting).
 */
export function reconnected(state: ChoiceState): { state: ChoiceState; resend: ProcedureSelection | null } {
  const reset = { ...state, applied: 0 }
  if (!state.pending) return { state: reset, resend: null }
  return {
    state: { ...reset, pending: { ...state.pending, attempts: state.pending.attempts + 1 } },
    resend: state.pending.selection
  }
}

/**
 * The PC has not confirmed the pending choice in CONFIRM_MS. Sent again, until MAX_ATTEMPTS: then the screen gives up, shows what the
 * PC really has, and says so.
 *
 * @param state The state.
 * @param latest The newest route the PC sent for this flight, if any.
 * @returns The state, and the choice to send again (null when none, or when given up).
 */
export function confirmTimeout(
  state: ChoiceState,
  latest: PlannedRoute | undefined
): { state: ChoiceState; resend: ProcedureSelection | null } {
  const { pending } = state
  if (!pending) return { state, resend: null }
  if (pending.attempts < MAX_ATTEMPTS) {
    return {
      state: { ...state, pending: { ...pending, attempts: pending.attempts + 1 } },
      resend: pending.selection
    }
  }
  return {
    state: {
      ...state,
      selection: latest ? latest.selection : state.selection,
      applied: latest ? latest.revision : state.applied,
      pending: null,
      unconfirmed: true
    },
    resend: null
  }
}
