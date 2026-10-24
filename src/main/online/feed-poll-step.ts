/**
 * When to fetch a network's feed: a pure step function, the clock an input (coding-standards.md §10), so the rules that keep WingLog
 * inside the networks' terms are tested rather than waited for. `NetworkFeedService` wraps it with real timers.
 *
 * IVAO bans the IP of a client that reads Whazzup more than once per 15 s (Regulation D.4), so the 15 s floor holds for both networks,
 * whatever is asked. Plan: winglog-backend docs/plans/vatsim-build.md, Step 1b.
 */
import type { OnlineNetwork } from '@shared/ipc'

/** The shortest time between two requests to a feed, both networks, milliseconds. */
export const FEED_FLOOR_MS = 15_000
/** The interval while traffic is drawn, milliseconds: the networks' own refresh rate. */
export const TRAFFIC_INTERVAL_MS = 15_000
/** The interval while only the pilot's own online status is wanted, milliseconds. */
export const STATUS_INTERVAL_MS = 60_000
/** How long to wait after the 1st, 2nd, 3rd... failure in a row, seconds; the last holds for every later one. */
const BACKOFF_S = [30, 60, 120, 240, 300]

/** What the service remembers between steps. */
export interface PollState {
  network: OnlineNetwork | null
  inFlight: boolean
  /** When the last request started. Kept across a change of network, so switching cannot beat the floor. */
  lastStartMs: number | null
  /** Failures in a row since the last success. */
  failures: number
  /** No request before this time, set after a failure; null when there is none to wait for. */
  retryAtMs: number | null
}

/** What is asked of the step. */
export interface PollInput {
  nowMs: number
  network: OnlineNetwork | null
  /** 'traffic': the map is showing it. 'status': only the pilot's own status. 'none': nothing needs the feed. */
  wanted: 'traffic' | 'status' | 'none'
}

/** What the step decides. */
export interface PollStep {
  state: PollState
  /** True: start a request now. */
  fetchNow: boolean
  /** When to call the step again if nothing else happens first; null when nothing is waited for. */
  wakeAtMs: number | null
}

/** @returns The state before anything has happened. */
export function initialPollState(): PollState {
  return { network: null, inFlight: false, lastStartMs: null, failures: 0, retryAtMs: null }
}

/**
 * @param wanted What needs the feed.
 * @returns The interval for it, milliseconds.
 */
function intervalFor(wanted: 'traffic' | 'status'): number {
  return wanted === 'traffic' ? TRAFFIC_INTERVAL_MS : STATUS_INTERVAL_MS
}

/**
 * Decides whether to start a request now.
 *
 * @param state What happened so far.
 * @param input The time, the network chosen and what needs the feed.
 * @returns The new state, whether to fetch, and when to look again.
 */
export function stepPoll(state: PollState, input: PollInput): PollStep {
  // A different network is a different feed: forget its failures and any request in flight, but not when the last one started.
  const current: PollState =
    state.network === input.network
      ? state
      : { ...initialPollState(), network: input.network, lastStartMs: state.lastStartMs }
  if (input.network === null || input.wanted === 'none')
    return { state: current, fetchNow: false, wakeAtMs: null }
  if (current.inFlight) return { state: current, fetchNow: false, wakeAtMs: null }

  const sinceLast = current.lastStartMs === null ? 0 : current.lastStartMs + intervalFor(input.wanted)
  const floor = current.lastStartMs === null ? 0 : current.lastStartMs + FEED_FLOOR_MS
  const dueMs = Math.max(sinceLast, floor, current.retryAtMs ?? 0)
  if (input.nowMs < dueMs) return { state: current, fetchNow: false, wakeAtMs: dueMs }
  return {
    state: { ...current, inFlight: true, lastStartMs: input.nowMs },
    fetchNow: true,
    wakeAtMs: null
  }
}

/**
 * Records how a request ended.
 *
 * @param state The state while it was in flight.
 * @param ok Whether it gave a usable feed.
 * @param nowMs When it ended.
 * @returns The state after it: a success clears the failures, a failure waits 30, 60, 120, 240 and then 300 s.
 */
export function pollFinished(state: PollState, ok: boolean, nowMs: number): PollState {
  if (ok) return { ...state, inFlight: false, failures: 0, retryAtMs: null }
  const failures = state.failures + 1
  const waitS = BACKOFF_S[Math.min(failures, BACKOFF_S.length) - 1] ?? 300
  return { ...state, inFlight: false, failures, retryAtMs: nowMs + waitS * 1000 }
}
