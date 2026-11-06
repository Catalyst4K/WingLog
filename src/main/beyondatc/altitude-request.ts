/**
 * Asks BeyondATC for a new cruise level through its own menu: pick Request Altitude, choose the
 * level offered nearest the target, and wait for the InfoBoxes to confirm it.
 */
import type { BeyondAtcState } from '@shared/ipc'
import { boxClearedLevelFt } from '@shared/atc-info-boxes'
import { METRES_PER_FOOT } from '@shared/units'

/**
 * Asks BeyondATC for a new cruise altitude over its WebSocket, in the two-step flow documented in winglog-backend's
 * docs/beyondatc-notes.md ("requesting a new cruise altitude"):
 *
 *   set_action: Request Altitude Change   → Player: "request new cruise altitude."
 *   (ATC: "Say again altitude.")          → Actions: [Cancel Altitude Change¬FL320¬…¬FL380¬Say Again¬]
 *   set_action: FL380                     → Player: "Request FL380"
 *                                          → ATC: "roger, new cruise altitude FL380."
 *                                            (and the cleared-level InfoBox shows FL380)
 *
 * There is no altitude command: BeyondATC's toolbar only sends `set_action` with an offered label, and a level label sent while
 * it isn't on offer is silently ignored. So the level list must be waited for, and the wanted level picked from it.
 */

export const REQUEST_ALTITUDE_ACTION = 'Request Altitude Change'
export const CANCEL_ALTITUDE_ACTION = 'Cancel Altitude Change'
const FEET_PER_METRE = 1 / METRES_PER_FOOT
/** How close an offered level must be to count as the one wanted — FL labels are exact to
 *  100 ft; a metric level converts to a non-round number of feet. */
const LEVEL_MATCH_TOLERANCE_FT = 150

export type AltitudeRequestOutcome =
  /** BeyondATC's cleared-level InfoBox shows the new level. */
  | 'granted'
  /** BeyondATC isn't offering "Request Altitude Change" right now (not in cruise, busy…). */
  | 'unavailable'
  /** The level list never appeared. */
  | 'noMenu'
  /** The level list appeared but didn't include the wanted level (cancelled). */
  | 'notOffered'
  /** The level was requested but the cleared-level box never showed it. */
  | 'noAnswer'

/** The slice of BeyondAtcService this needs — structural, so tests can drive it directly. */
export interface AltitudeRequestSession {
  getState(): BeyondAtcState
  setAction(label: string): void
  on(event: 'state', listener: (state: BeyondAtcState) => void): unknown
  off(event: 'state', listener: (state: BeyondAtcState) => void): unknown
}

export interface AltitudeRequestTimeouts {
  menuMs: number
  answerMs: number
}

/**
 * The menu waits for a quiet frequency: BeyondATC queues the request until the controller has finished with other traffic
 * (flight 262, 2026-11-06: queued 01:57:56, the pilot's call went out at 01:58:14, the list appeared at 01:58:22, 26 s on). A
 * wait that gave up at 20 s left the list open for seven hours.
 */
const DEFAULT_TIMEOUTS: AltitudeRequestTimeouts = { menuMs: 60_000, answerMs: 30_000 }
/** After giving up on the list, how long to keep watching for it, to close it if it still turns up. */
const LATE_MENU_WATCH_MS = 180_000

/** "FL380" → 38000; "11300m" / "11,300 m" → feet (for China's metric levels, whose exact
 *  label BeyondATC uses hasn't been captured yet — both notations accepted). Null for any
 *  non-level label ("Say Again", "Cancel Altitude Change").
 *
 * @param label A level as BeyondATC labels it.
 * @returns Feet, or null when it isn't a level.
 */
export function levelLabelToFeet(label: string): number | null {
  const fl = /^FL ?(\d{2,3})$/i.exec(label.trim())
  if (fl) return Number(fl[1]) * 100
  const metric = /^([\d,]+) ?m$/i.exec(label.trim())
  if (metric?.[1]) return Number(metric[1].replace(/,/g, '')) * FEET_PER_METRE
  return null
}

/**
 * The offered label nearest to the wanted level, if it's within tolerance.
 *
 * @param actions The menu's labels.
 * @param targetFt The level wanted, feet.
 * @returns The label, or null.
 */
export function pickLevelLabel(actions: string[], targetFt: number): string | null {
  let best: { label: string; diff: number } | null = null
  for (const label of actions) {
    const feet = levelLabelToFeet(label)
    if (feet === null) continue
    const diff = Math.abs(feet - targetFt)
    if (diff <= LEVEL_MATCH_TOLERANCE_FT && (!best || diff < best.diff)) best = { label, diff }
  }
  return best?.label ?? null
}

/** Whether BeyondATC's InfoBoxes, changed since the request, show this level as cleared
 * (winglog-backend's docs/decisions.md: boxes only, no speech).
 *
 * @param state BeyondATC's state.
 * @param label The level requested.
 * @param sentAt When it was requested, epoch ms.
 * @returns Whether it's confirmed.
 */
export function boxConfirmsLevel(state: BeyondAtcState, label: string, sentAt: number): boolean {
  const wanted = levelLabelToFeet(label)
  const cleared = boxClearedLevelFt(state.infoBoxes)
  return (
    wanted !== null &&
    cleared !== null &&
    state.infoBoxesAt !== null &&
    state.infoBoxesAt >= sentAt &&
    Math.abs(cleared - wanted) <= LEVEL_MATCH_TOLERANCE_FT
  )
}

/**
 * Resolves with the first non-null result of `check`, tried now and again on every session `event`, or
 * with null after `timeoutMs`.
 *
 * @param session BeyondATC's connection.
 * @param event The session event that can change the answer.
 * @param check Returns the wanted value, or null while it is not there yet.
 * @param timeoutMs How long to wait, milliseconds.
 * @returns The value `check` returned, or null on timeout.
 */
function waitFor<T>(
  session: AltitudeRequestSession,
  event: 'state',
  check: () => T | null,
  timeoutMs: number
): Promise<T | null> {
  const immediate = check()
  if (immediate !== null) return Promise.resolve(immediate)
  return new Promise((resolve) => {
    const listener = (): void => {
      const value = check()
      if (value === null) return
      done(value)
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    const done = (value: T | null): void => {
      clearTimeout(timer)
      session.off(event, listener)
      resolve(value)
    }
    session.on(event, listener)
  })
}

/**
 * A request gave up waiting for the level list, but the request is still queued in BeyondATC: if the list turns up later, nobody
 * is there to choose from it, and BeyondATC keeps asking "say again altitude" until someone does. Cancels it when it appears.
 *
 * @param session BeyondATC's connection.
 * @returns Stops the watch; the caller stops it when a newer request starts, so that one is never cancelled out from under itself.
 */
function watchForLateMenu(session: AltitudeRequestSession): () => void {
  const stop = (): void => {
    clearTimeout(timer)
    session.off('state', listener)
  }
  const listener = (): void => {
    if (!session.getState().actions.includes(CANCEL_ALTITUDE_ACTION)) return
    stop()
    session.setAction(CANCEL_ALTITUDE_ACTION)
  }
  const timer = setTimeout(stop, LATE_MENU_WATCH_MS)
  session.on('state', listener)
  return stop
}

/**
 * Requests a level from BeyondATC and waits for the clearance.
 *
 * @param session BeyondATC's connection.
 * @param targetFt The level wanted, feet.
 * @param timeouts How long to wait for the menu and the clearance.
 * @returns What happened, and the level label used. With no list ('noMenu'), also how to stop the watch for it turning up late.
 */
export async function requestAltitude(
  session: AltitudeRequestSession,
  targetFt: number,
  timeouts: AltitudeRequestTimeouts = DEFAULT_TIMEOUTS
): Promise<{ outcome: AltitudeRequestOutcome; label: string | null; stopWatching?: () => void }> {
  // A level list already open (an earlier request's, or the pilot's) is used as it is: BeyondATC offers no second request while
  // it waits for a level, and would keep asking for one.
  const listOpen = session.getState().actions.includes(CANCEL_ALTITUDE_ACTION)
  if (!listOpen && !session.getState().actions.includes(REQUEST_ALTITUDE_ACTION))
    return { outcome: 'unavailable', label: null }

  if (!listOpen) session.setAction(REQUEST_ALTITUDE_ACTION)
  const levels = await waitFor(
    session,
    'state',
    () => {
      const actions = session.getState().actions
      return actions.includes(CANCEL_ALTITUDE_ACTION) ? actions : null
    },
    timeouts.menuMs
  )
  if (!levels) return { outcome: 'noMenu', label: null, stopWatching: watchForLateMenu(session) }

  const label = pickLevelLabel(levels, targetFt)
  if (!label) {
    session.setAction(CANCEL_ALTITUDE_ACTION)
    return { outcome: 'notOffered', label: null }
  }

  const sentAt = Date.now()
  session.setAction(label)
  const confirmed = await waitFor(
    session,
    'state',
    () => (boxConfirmsLevel(session.getState(), label, sentAt) ? true : null),
    timeouts.answerMs
  )
  return { outcome: confirmed ? 'granted' : 'noAnswer', label }
}
