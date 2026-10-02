import type { BeyondAtcState, BeyondAtcTranscriptEntry } from '@shared/ipc'

/**
 * Asks BeyondATC for a new cruise altitude over its WebSocket — the exact two-step flow
 * confirmed live 2026-10-01 (flightdeck-backend's docs/beyondatc-notes.md, "requesting a new
 * cruise altitude"):
 *
 *   set_action: Request Altitude Change   → Player: "request new cruise altitude."
 *   (ATC: "Say again altitude.")          → Actions: [Cancel Altitude Change¬FL320¬…¬FL380¬Say Again¬]
 *   set_action: FL380                     → Player: "Request FL380"
 *                                          → ATC: "roger, new cruise altitude FL380."
 *
 * There is no altitude command: BeyondATC's own toolbar only ever sends `set_action` with an
 * offered label, and a level label sent while it isn't on offer is silently ignored (also
 * confirmed live). So the level list must be waited for, and the wanted level picked from it.
 */

export const REQUEST_ALTITUDE_ACTION = 'Request Altitude Change'
export const CANCEL_ALTITUDE_ACTION = 'Cancel Altitude Change'
const FEET_PER_METRE = 1 / 0.3048
/** How close an offered level must be to count as the one wanted — FL labels are exact to
 *  100 ft; a metric level converts to a non-round number of feet. */
const LEVEL_MATCH_TOLERANCE_FT = 150

export type AltitudeRequestOutcome =
  /** ATC confirmed the new level. */
  | 'granted'
  /** BeyondATC isn't offering "Request Altitude Change" right now (not in cruise, busy…). */
  | 'unavailable'
  /** The level list never appeared. */
  | 'noMenu'
  /** The level list appeared but didn't include the wanted level (cancelled). */
  | 'notOffered'
  /** The level was requested but ATC never confirmed it. */
  | 'noAnswer'

/** The slice of BeyondAtcService this needs — structural, so tests can drive it directly. */
export interface AltitudeRequestSession {
  getState(): BeyondAtcState
  getTranscript(): BeyondAtcTranscriptEntry[]
  setAction(label: string): void
  on(event: 'state', listener: (state: BeyondAtcState) => void): unknown
  on(event: 'transcript', listener: (transcript: BeyondAtcTranscriptEntry[]) => void): unknown
  off(event: 'state', listener: (state: BeyondAtcState) => void): unknown
  off(event: 'transcript', listener: (transcript: BeyondAtcTranscriptEntry[]) => void): unknown
}

export interface AltitudeRequestTimeouts {
  menuMs: number
  answerMs: number
}

const DEFAULT_TIMEOUTS: AltitudeRequestTimeouts = { menuMs: 20_000, answerMs: 30_000 }

/** "FL380" → 38000; "11300m" / "11,300 m" → feet (for China's metric levels, whose exact
 *  label BeyondATC uses hasn't been captured yet — both notations accepted). Null for any
 *  non-level label ("Say Again", "Cancel Altitude Change"). */
export function levelLabelToFeet(label: string): number | null {
  const fl = /^FL ?(\d{2,3})$/i.exec(label.trim())
  if (fl) return Number(fl[1]) * 100
  const metric = /^([\d,]+) ?m$/i.exec(label.trim())
  if (metric) return Number(metric[1]!.replace(/,/g, '')) * FEET_PER_METRE
  return null
}

/** The offered label nearest to the wanted level, if it's within tolerance. */
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

/** Whether an ATC line confirms this level: "new cruise altitude FL380" (seen live) or a
 *  plain "climb FL380" / "climb to FL380". */
export function confirmsLevel(text: string, label: string): boolean {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, ' ?')
  return new RegExp(`(?:new cruise altitude|climb(?: and maintain)?(?: to)?) ${escaped}\\b`, 'i').test(text)
}

function waitFor<T>(
  session: AltitudeRequestSession,
  event: 'state' | 'transcript',
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
      session.off(event as 'state', listener)
      resolve(value)
    }
    session.on(event as 'state', listener)
  })
}

export async function requestAltitude(
  session: AltitudeRequestSession,
  targetFt: number,
  timeouts: AltitudeRequestTimeouts = DEFAULT_TIMEOUTS
): Promise<{ outcome: AltitudeRequestOutcome; label: string | null }> {
  if (!session.getState().actions.includes(REQUEST_ALTITUDE_ACTION)) return { outcome: 'unavailable', label: null }

  session.setAction(REQUEST_ALTITUDE_ACTION)
  const levels = await waitFor(
    session,
    'state',
    () => {
      const actions = session.getState().actions
      return actions.includes(CANCEL_ALTITUDE_ACTION) ? actions : null
    },
    timeouts.menuMs
  )
  if (!levels) return { outcome: 'noMenu', label: null }

  const label = pickLevelLabel(levels, targetFt)
  if (!label) {
    session.setAction(CANCEL_ALTITUDE_ACTION)
    return { outcome: 'notOffered', label: null }
  }

  // By timestamp, not index — the transcript is capped (BeyondAtcService keeps the last 100
  // lines), so "everything after line N" stops meaning anything once it's full.
  const sentAt = Date.now()
  session.setAction(label)
  const confirmed = await waitFor(
    session,
    'transcript',
    () =>
      session
        .getTranscript()
        .some((entry) => entry.ts >= sentAt && entry.speaker === 'atc' && confirmsLevel(entry.text, label))
        ? true
        : null,
    timeouts.answerMs
  )
  return { outcome: confirmed ? 'granted' : 'noAnswer', label }
}
