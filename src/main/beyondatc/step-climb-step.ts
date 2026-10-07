/**
 * The step-climb decision as pure step functions (coding-standards.md §10): `(state, input) → { state, logs, … }`.
 * `StepClimbController` (step-climb.ts) holds the state, calls BeyondATC, writes the log lines and emits the status; the offline
 * simulation replays recorded flights through this same code. The clock and everything read from the world come in as input.
 * See step-climb.ts for what the feature does and why.
 */
import type { ActiveTracking, BeyondAtcStepClimbStatus, SimTelemetry } from '@shared/ipc'
import { greatCircleNm } from '@shared/geo'
import {
  CLIMB_SUSTAIN_MS,
  CLIMB_VS_MS,
  EMPTY_STEP_PLAN,
  FCU_CHANGE_FT,
  FCU_SETTLE_MS,
  FEET_PER_METRE,
  MAX_ATTEMPTS,
  MAX_UNPLANNED_STEP_FT,
  NO_TOD_CUTOFF_NM,
  PLANNED_MATCH_FT,
  RETRY_AFTER_MS,
  STEP_THRESHOLD_FT,
  extractStepPlan,
  leadDistanceNm,
  nearestFixIndex,
  roundLevel,
  type StepPlan,
  type StepTarget
} from './step-climb-plan'

/** How many times a level has been asked for, and when last. */
export interface Attempt {
  count: number
  lastAt: number
}

/** Everything the step-climb decision remembers between ticks. */
export interface StepClimbState {
  enabled: boolean
  flightId: number | null
  plan: StepPlan
  /** The furthest route fix the aircraft has been nearest to — steps before it are behind. */
  progress: number
  /** Attempts per level, keyed by the level rounded to 100 ft. */
  attempts: Record<number, Attempt>
  /** Levels given up on, rounded to 100 ft. */
  dropped: number[]
  inFlight: number | null
  fcu: { valueFt: number; since: number } | null
  climbingSince: number | null
  waitingForClimb: number | null
  pastTopOfDescent: boolean
  last: BeyondAtcStepClimbStatus['last']
  nextStep: BeyondAtcStepClimbStatus['nextStep']
  loggedCleared: number | null
  /** The last cleared level BeyondATC's InfoBoxes showed this flight. Kept, since the box set
   *  is replaced by the next instruction (a frequency change) minutes later. */
  boxCleared: number | null
  loggedNext: string
}

/** Step climb switched off, with nothing remembered. */
export const INITIAL_STEP_CLIMB_STATE: StepClimbState = {
  enabled: false,
  flightId: null,
  plan: EMPTY_STEP_PLAN,
  progress: 0,
  attempts: {},
  dropped: [],
  inFlight: null,
  fcu: null,
  climbingSince: null,
  waitingForClimb: null,
  pastTopOfDescent: false,
  last: null,
  nextStep: null,
  loggedCleared: null,
  boxCleared: null,
  loggedNext: ''
}

/** What one telemetry tick brings. */
export interface StepClimbTick {
  t: SimTelemetry
  /** Epoch ms. */
  now: number
  active: ActiveTracking | undefined
  /** The level BeyondATC's InfoBoxes show as cleared, or null (including with no session). */
  boxLevelFt: number | null
  /** Whether BeyondATC is connected; only asked when a request could go out. */
  isConnected: () => boolean
  /** The flight's stored OFP, read when a new flight starts being tracked. */
  getOfpJson: (flightId: number) => string | null
}

/** A level to ask for, and why. */
export interface StepClimbTarget {
  altitudeFt: number
  reason: 'simbrief' | 'fcu'
}

/** What a step produced. */
export interface StepClimbResult {
  state: StepClimbState
  /** Decision-trail lines for main.log, in order. */
  logs: string[]
  /** A request to send now, if one is due (its attempt is already counted in `state`). */
  fire: StepClimbTarget | null
}

/**
 * The status the UI shows.
 *
 * @param state The state.
 * @returns The status.
 */
export function stepClimbStatus(state: StepClimbState): BeyondAtcStepClimbStatus {
  return {
    enabled: state.enabled,
    nextStep: state.nextStep,
    pendingAltitudeFt: state.inFlight,
    waitingForClimbFt: state.waitingForClimb,
    pastTopOfDescent: state.pastTopOfDescent,
    last: state.last
  }
}

/**
 * Switches step climb on or off. Off forgets the next step, the FCU level and the climb being waited for.
 *
 * @param state The state now.
 * @param enabled The new setting.
 * @returns The state after, and the log line if the setting changed.
 */
export function setStepClimbEnabled(state: StepClimbState, enabled: boolean): StepClimbResult {
  const logs = enabled !== state.enabled ? [enabled ? 'enabled' : 'disabled'] : []
  const next: StepClimbState = enabled
    ? { ...state, enabled }
    : { ...state, enabled, nextStep: null, fcu: null, waitingForClimb: null }
  return { state: next, logs, fire: null }
}

/**
 * One telemetry tick: follows the active flight, tracks the FCU altitude and the climb, and, in cruise with BeyondATC
 * connected, says whether a level should be asked for now.
 *
 * @param state The state now.
 * @param tick The telemetry and what was read from the world.
 * @returns The state after, the log lines, and the request due, if any.
 */
export function tickStepClimb(state: StepClimbState, tick: StepClimbTick): StepClimbResult {
  if (!state.enabled) return { state, logs: [], fire: null }
  const logs: string[] = []
  const { t, now, active } = tick
  if (!active) return { state: { ...state, flightId: null, nextStep: null }, logs, fire: null }

  // A draft: this copy is changed in place below, so `state` itself is never touched.
  const s: StepClimbState = { ...state, attempts: { ...state.attempts }, dropped: [...state.dropped] }
  if (active.flightId !== s.flightId) followFlight(s, active.flightId, tick.getOfpJson, logs)
  trackFcu(s, t, now, active.phase, logs)
  s.climbingSince = t.verticalSpeedMs > CLIMB_VS_MS ? (s.climbingSince ?? now) : null

  const clearedFt = clearedLevelFt(s, t, tick.boxLevelFt, logs)
  updateProgress(s, t, logs)
  const { upcoming, upcomingDistance } = findUpcomingStep(s, t, clearedFt, logs)

  s.waitingForClimb = null
  let fire: StepClimbTarget | null = null
  if (s.inFlight === null && !s.pastTopOfDescent && active.phase === 'cruise' && tick.isConnected()) {
    fire = pickTarget(s, t, now, clearedFt, upcoming, upcomingDistance)
    if (fire) recordAttempt(s, fire, now, logs)
  }
  return { state: s, logs, fire }
}

/**
 * A request has been answered.
 *
 * @param state The state now.
 * @param done What was asked for and what came back.
 * @param done.altitudeFt The level asked for.
 * @param done.reason Why it was asked for.
 * @param done.outcome BeyondATC's answer.
 * @param done.attempt Which attempt at the level this was, as counted when it was sent.
 * @returns The state after: a granted level's attempts forgotten, a level refused too often dropped, and the result noted.
 */
export function settleRequest(
  state: StepClimbState,
  done: {
    altitudeFt: number
    reason: StepClimbTarget['reason']
    outcome: NonNullable<StepClimbState['last']>['outcome']
    attempt: number
  }
): StepClimbResult {
  const key = roundLevel(done.altitudeFt)
  const attempts = { ...state.attempts }
  const dropped = [...state.dropped]
  if (done.outcome === 'granted') delete attempts[key]
  else if (done.attempt >= MAX_ATTEMPTS && !dropped.includes(key)) dropped.push(key)
  const isDropped = dropped.includes(key)
  const logs = [`request ${key} ft: ${done.outcome}${isDropped ? ', dropped' : ''}`]
  const last = {
    altitudeFt: key,
    outcome: done.outcome,
    attempt: done.attempt,
    reason: done.reason,
    dropped: isDropped
  }
  return { state: { ...state, attempts, dropped, last }, logs, fire: null }
}

/**
 * The request has finished, however it ended.
 *
 * @param state The state now.
 * @returns The state with no request in flight.
 */
export function finishRequest(state: StepClimbState): StepClimbState {
  return { ...state, inFlight: null }
}

/**
 * A new flight is being tracked: load its step plan and start over.
 *
 * @param s The draft state.
 * @param flightId The flight now tracked.
 * @param getOfpJson Reads the flight's stored OFP.
 * @param logs The log lines so far.
 */
function followFlight(
  s: StepClimbState,
  flightId: number,
  getOfpJson: StepClimbTick['getOfpJson'],
  logs: string[]
): void {
  s.flightId = flightId
  s.plan = extractStepPlan(getOfpJson(flightId))
  s.progress = 0
  s.attempts = {}
  s.dropped = []
  s.last = null
  s.pastTopOfDescent = false
  s.boxCleared = null
  logs.push(
    `flight ${flightId}: ${s.plan.fixes.length} route fixes, steps ` +
      (s.plan.steps.map((step) => `${step.ident}@${Math.round(step.altitudeFt)}`).join(' ') || 'none')
  )
}

/**
 * Notes when the autopilot's selected altitude changes (by more than FCU_CHANGE_FT).
 *
 * @param s The draft state.
 * @param t This tick.
 * @param now Epoch ms.
 * @param phase The flight phase, for the log.
 * @param logs The log lines so far.
 */
function trackFcu(
  s: StepClimbState,
  t: SimTelemetry,
  now: number,
  phase: ActiveTracking['phase'],
  logs: string[]
): void {
  if (typeof t.apSelectedAltitudeM !== 'number') return
  const selectedFt = t.apSelectedAltitudeM * FEET_PER_METRE
  if (!s.fcu || Math.abs(selectedFt - s.fcu.valueFt) > FCU_CHANGE_FT) {
    s.fcu = { valueFt: selectedFt, since: now }
    logs.push(`FCU altitude ${Math.round(selectedFt)} ft (phase ${phase})`)
  }
}

/**
 * The level ATC has cleared, from BeyondATC's InfoBoxes (decisions.md, 2026-10-05: boxes only, no speech), or the current
 * altitude rounded to 1,000 ft when no level has been given.
 *
 * @param s The draft state.
 * @param t This tick.
 * @param boxLevelFt The level the boxes show, or null.
 * @param logs The log lines so far.
 * @returns Feet.
 */
function clearedLevelFt(
  s: StepClimbState,
  t: SimTelemetry,
  boxLevelFt: number | null,
  logs: string[]
): number {
  if (boxLevelFt !== null) s.boxCleared = boxLevelFt
  const clearedFt = s.boxCleared ?? Math.round((t.pressureAltitudeM * FEET_PER_METRE) / 1000) * 1000
  if (clearedFt !== s.loggedCleared) {
    s.loggedCleared = clearedFt
    logs.push(
      `cleared level ${clearedFt} ft (${s.boxCleared !== null ? 'from InfoBoxes' : 'no ATC level, using altitude'})`
    )
  }
  return clearedFt
}

/**
 * Moves progress along the route, and notes passing the top of descent.
 *
 * @param s The draft state.
 * @param t This tick.
 * @param logs The log lines so far.
 */
function updateProgress(s: StepClimbState, t: SimTelemetry, logs: string[]): void {
  s.progress = Math.max(s.progress, nearestFixIndex(s.plan.fixes, t.latitude, t.longitude))
  if (!s.pastTopOfDescent && isPastTopOfDescent(s, t)) {
    s.pastTopOfDescent = true
    logs.push('past top of descent: no more requests this flight')
  }
}

/**
 * Nearest-fix progress reaching TOD counts as past it — up to half a leg early, which only matters to a step planned right at
 * TOD, which never happens.
 *
 * @param s The draft state.
 * @param t This tick.
 * @returns Whether the top of descent is behind.
 */
function isPastTopOfDescent(s: StepClimbState, t: SimTelemetry): boolean {
  if (s.plan.todOrder !== null) return s.progress >= s.plan.todOrder
  const destination = s.plan.fixes.at(-1)
  return (
    destination !== undefined &&
    greatCircleNm({ lat: t.latitude, lon: t.longitude }, destination) < NO_TOD_CUTOFF_NM
  )
}

/**
 * The next planned climb still ahead and above the cleared level, shown as the next step. A step already behind (switched on
 * late, or a step not taken) doesn't hold up the ones after it.
 *
 * @param s The draft state.
 * @param t This tick.
 * @param clearedFt The cleared level, feet.
 * @param logs The log lines so far.
 * @returns The step, and its distance in nm; both undefined or null when there isn't one.
 */
function findUpcomingStep(
  s: StepClimbState,
  t: SimTelemetry,
  clearedFt: number,
  logs: string[]
): { upcoming: StepTarget | undefined; upcomingDistance: number | null } {
  const upcoming = s.pastTopOfDescent
    ? undefined
    : s.plan.steps.find(
        (step) =>
          step.order >= s.progress &&
          step.altitudeFt > clearedFt + STEP_THRESHOLD_FT &&
          !s.dropped.includes(roundLevel(step.altitudeFt))
      )
  const upcomingDistance = upcoming ? greatCircleNm({ lat: t.latitude, lon: t.longitude }, upcoming) : null
  s.nextStep =
    upcoming && upcomingDistance !== null
      ? { ident: upcoming.ident, altitudeFt: upcoming.altitudeFt, distanceNm: Math.round(upcomingDistance) }
      : null
  const nextKey = upcoming ? `${upcoming.ident}@${Math.round(upcoming.altitudeFt)}` : 'none'
  if (nextKey !== s.loggedNext) {
    s.loggedNext = nextKey
    logs.push(
      `next step ${nextKey}${upcomingDistance !== null ? ` (${Math.round(upcomingDistance)} nm)` : ''}`
    )
  }
  return { upcoming, upcomingDistance }
}

/**
 * Chooses the level to request now: the planned step once the aircraft is within the lead distance, or an FCU altitude the pilot
 * has held long enough. Levels already requested recently, or dropped after too many attempts, are skipped.
 *
 * @param s The draft state; `waitingForClimb` is set when an FCU level waits for a sustained climb.
 * @param t The latest telemetry.
 * @param now The current time, epoch milliseconds.
 * @param clearedFt The level ATC has cleared, feet.
 * @param upcoming The next planned step, if any.
 * @param upcomingDistance Distance along the route to that step, nautical miles, or null when unknown.
 * @returns The level to ask for and why, or null when nothing is due.
 */
function pickTarget(
  s: StepClimbState,
  t: SimTelemetry,
  now: number,
  clearedFt: number,
  upcoming: StepTarget | undefined,
  upcomingDistance: number | null
): StepClimbTarget | null {
  const candidates: StepClimbTarget[] = []
  if (upcoming && upcomingDistance !== null && upcomingDistance <= leadDistanceNm(t.groundSpeedMs)) {
    candidates.push({ altitudeFt: upcoming.altitudeFt, reason: 'simbrief' })
  }
  if (s.fcu && now - s.fcu.since >= FCU_SETTLE_MS && s.fcu.valueFt > clearedFt + STEP_THRESHOLD_FT) {
    const fcuFt = s.fcu.valueFt
    if (upcoming && Math.abs(fcuFt - upcoming.altitudeFt) <= PLANNED_MATCH_FT) {
      // The aircraft starting the planned step early — ask for the plan's level now.
      candidates.push({ altitudeFt: upcoming.altitudeFt, reason: 'fcu' })
    } else if (fcuFt <= clearedFt + MAX_UNPLANNED_STEP_FT) {
      if (s.climbingSince !== null && now - s.climbingSince >= CLIMB_SUSTAIN_MS) {
        candidates.push({ altitudeFt: roundLevel(fcuFt), reason: 'fcu' })
      } else {
        s.waitingForClimb = roundLevel(fcuFt)
      }
    }
  }
  return (
    candidates.find((c) => {
      const key = roundLevel(c.altitudeFt)
      if (s.dropped.includes(key)) return false
      const attempt = s.attempts[key]
      return !attempt || now - attempt.lastAt >= RETRY_AFTER_MS
    }) ?? null
  )
}

/**
 * Counts a request as made: one more attempt at the level, and it is in flight.
 *
 * @param s The draft state.
 * @param target The level being asked for.
 * @param now Epoch ms.
 * @param logs The log lines so far.
 */
function recordAttempt(s: StepClimbState, target: StepClimbTarget, now: number, logs: string[]): void {
  const key = roundLevel(target.altitudeFt)
  const attempt = { count: (s.attempts[key]?.count ?? 0) + 1, lastAt: now }
  s.attempts[key] = attempt
  s.inFlight = key
  logs.push(
    `requesting ${Math.round(target.altitudeFt)} ft (trigger ${target.reason}, attempt ${attempt.count})`
  )
}
