/**
 * The GSX routine runner (winglog-backend's docs/plans/gsx-service-presets.md, "The runner"): a pure step function
 * (coding-standards.md §10). GSX's services and menu, the aircraft, the data-entry guard and the clock go in; the new run and
 * the menu actions to send come out. The driver connects it to GSX Remote and the telemetry, so recorded flights can be
 * replayed through exactly this code.
 *
 * One request is in flight at a time (`routine-attempt.ts`); stages overlap freely, since a stage waits only for the services
 * it names. The runner never retries beyond the one dropped request, and stops cleanly when the pilot cancels, GSX goes away,
 * the aircraft moves or pushback is requested.
 */
import type { GsxRoutineService } from '@shared/gsx-routines'
import type {
  GsxRoutineCancelChoice,
  GsxRoutineNote,
  GsxRoutineStopReason
} from '@shared/gsx-routine-progress'
import { decideFollowUp, isAdditionalServicesMenu, isMainMenu, isRefuelingLevelMenu } from './routine-menu'
import { stepAttempt } from './routine-attempt'
import { startWindDown, stepWindDown, windDownQueue } from './routine-winddown'
import {
  adoptService,
  endRun,
  pickAction,
  routineServiceRuns,
  serviceById,
  serviceRun,
  skipService,
  isSettled,
  type RoutineRun,
  type RunnerAction,
  type RunnerInput,
  type RunnerStep
} from './routine-run'

/** A request GSX dropped (back to `available` without running) is asked for once more after this. */
const DROPPED_RETRY_MS = 10_000
/** A stage still waiting after this says so in its status, and nothing else happens. */
const STALLED_MS = 30 * 60_000
/** A menu that opens within this of the routine's own pick is that pick's follow-up. */
const FOLLOW_UP_WINDOW_MS = 2_000
/** Do not answer a follow-up twice: the menu takes a moment to close after the pick. */
const FOLLOW_UP_PICK_GAP_MS = 1_500
/** A skipped service stays in the status line this long. */
const SKIP_NOTE_MS = 8_000
/** The "an entry timed out" note stays in the status line this long. */
const TIMEOUT_NOTE_MS = 60_000

/**
 * @param state A GSX service state.
 * @returns Whether GSX has the service under way or has finished it.
 */
function isTaken(state: string): boolean {
  return state === 'requested' || state === 'performing' || state === 'completing' || state === 'completed'
}

/**
 * @param input The step's input.
 * @returns Why the routine must stop now, or null.
 */
function stopReasonFor(input: RunnerInput): GsxRoutineStopReason | null {
  if (!input.gsxConnected) return 'gsx-disconnected'
  if (input.aircraftMoving) return 'aircraft-moved'
  const departure = serviceById(input.services, 'Departure')
  if (departure && (departure.state === 'requested' || departure.state === 'performing')) return 'departure'
  return null
}

/**
 * Follows the services the routine has asked for. A service finishes when GSX shows it `completed`, or back to `available`
 * after it ran. A request that went back to `available` without running was dropped: asked for once more after a pause, then
 * treated as a service GSX does not offer.
 *
 * @param run The run, changed in place.
 * @param input The step's input.
 */
function trackServices(run: RoutineRun, input: RunnerInput): void {
  for (const { service, run: status } of routineServiceRuns(run)) {
    const gsx = serviceById(input.services, service)
    if (status.progress !== 'following' || !gsx) continue
    const previous = status.lastGsxState
    if (gsx.state === 'performing' || gsx.state === 'completing') status.hasPerformed = true
    if (gsx.state === 'completed' || (gsx.state === 'available' && status.hasPerformed)) {
      status.progress = 'done'
      run.lastProgressAtMs = input.nowMs
    } else if (gsx.state === 'bypassed') {
      skipService(run, service, 'bypassed', input, [])
    } else if (gsx.state === 'available' && previous === 'requested') {
      dropRequest(run, service, input.nowMs)
    }
    status.lastGsxState = gsx.state
  }
}

/**
 * @param run The run, changed in place.
 * @param service The service GSX dropped.
 * @param nowMs The clock.
 */
function dropRequest(run: RoutineRun, service: GsxRoutineService, nowMs: number): void {
  const status = serviceRun(run, service)
  run.lastProgressAtMs = nowMs
  if (status.hasBeenDropped) {
    status.progress = 'skipped'
    run.note = { code: 'skipped', service, reason: 'dropped' }
    return
  }
  status.hasBeenDropped = true
  status.progress = 'todo'
  status.retryAtMs = nowMs + DROPPED_RETRY_MS
}

/**
 * @param run The run.
 * @param stageIndex A stage.
 * @returns The services the stage still waits for.
 */
function unmetConditions(run: RoutineRun, stageIndex: number): GsxRoutineService[] {
  return run.routine.stages[stageIndex].startsWhen
    .map((condition) => condition.service)
    .filter((service) => !isSettled(serviceRun(run, service)))
}

/**
 * @param run The run.
 * @param input The step's input.
 * @returns The status line when nothing more specific applies: what the routine is waiting for.
 */
function restingNote(run: RoutineRun, input: RunnerInput): GsxRoutineNote {
  if (run.note.code === 'skipped' && input.nowMs - run.lastProgressAtMs < SKIP_NOTE_MS) return run.note
  const waitingStage = run.routine.stages.findIndex((stage) =>
    stage.services.some((service) => serviceRun(run, service).progress === 'todo')
  )
  const unmet = waitingStage < 0 ? [] : unmetConditions(run, waitingStage)
  if (unmet.length > 0) {
    const isStalled = input.nowMs - run.lastProgressAtMs >= STALLED_MS
    return { code: isStalled ? 'stalled' : 'waiting-for-stage', services: unmet }
  }
  const following = routineServiceRuns(run).filter(({ run: status }) => status.progress === 'following')
  if (following.length > 0) return { code: 'following', services: following.map(({ service }) => service) }
  return run.note.code === 'starting' ? run.note : { code: 'following', services: [] }
}

/**
 * A menu the pilot or GSX opened. The refuelling level and GSX's own default are answered when the routine said to; anything
 * else is the pilot's, and the routine waits for it to close.
 *
 * @param run The run, changed in place.
 * @param input The step's input.
 * @param actions Where a pick is added.
 */
function stepForeignMenu(run: RoutineRun, input: RunnerInput, actions: RunnerAction[]): void {
  const refueling = run.services.Refueling
  const decision = decideFollowUp(input.menu, {
    answerGsxChoice: run.routine.answerGsxChoice,
    pickBlockFuel:
      run.routine.fuel === 'simbrief-block' &&
      (refueling?.progress === 'asking' || refueling?.progress === 'following'),
    followsOwnPick: input.nowMs - run.lastOwnPickAtMs <= FOLLOW_UP_WINDOW_MS
  })
  if (decision.kind === 'pick') {
    if (input.nowMs - run.lastFollowUpPickAtMs >= FOLLOW_UP_PICK_GAP_MS) {
      actions.push(pickAction(input.menu, decision.index))
      run.lastFollowUpPickAtMs = input.nowMs
    }
    return
  }
  const hasWork = routineServiceRuns(run).some(
    ({ run: status }) => status.progress === 'todo' || status.progress === 'asking'
  )
  const isAwaitedLevel = isRefuelingLevelMenu(input.menu) && refueling !== undefined && !isSettled(refueling)
  if (hasWork || isAwaitedLevel) run.note = { code: 'waiting-for-pilot', menu: decision.title }
}

/**
 * @param service A service about to be requested.
 * @param input The step's input.
 * @returns Why the data-entry guard says to wait, or null.
 */
function guardNote(service: GsxRoutineService, input: RunnerInput): GsxRoutineNote | null {
  if (service === 'Boarding' && input.guard.fuelEntryOpen) {
    return { code: 'waiting-for-fuel-entry', gapKg: input.guard.fuelGapKg }
  }
  if (service === 'Refueling' && input.guard.payloadEntryOpen) return { code: 'waiting-for-payload-entry' }
  return null
}

/**
 * What GSX already says about a service whose turn has come: left out, or already under way and followed, or free to ask for.
 *
 * @param run The run, changed in place.
 * @param service The service.
 * @param input The step's input.
 * @returns Whether the service still has to be asked for.
 */
function resolveAgainstGsx(run: RoutineRun, service: GsxRoutineService, input: RunnerInput): boolean {
  const gsx = serviceById(input.services, service)
  if (!gsx) skipService(run, service, 'not-offered', input, [])
  else if (gsx.state === 'bypassed') skipService(run, service, 'bypassed', input, [])
  else if (isTaken(gsx.state)) adoptService(run, service, gsx, input.nowMs)
  else return true
  return false
}

/**
 * Starts the next request: the first service, in the routine's order, whose stage has its conditions met and which the guard
 * lets through. A service GSX already has under way is followed instead of asked for.
 *
 * @param run The run, changed in place.
 * @param input The step's input.
 * @param actions Where the menu actions are added.
 */
function startNext(run: RoutineRun, input: RunnerInput, actions: RunnerAction[]): void {
  let blocked: GsxRoutineNote | null = null
  for (const [stageIndex, stage] of run.routine.stages.entries()) {
    if (unmetConditions(run, stageIndex).length > 0) continue
    for (const service of stage.services) {
      const status = serviceRun(run, service)
      if (status.progress !== 'todo' || input.nowMs < status.retryAtMs) continue
      if (!resolveAgainstGsx(run, service, input)) continue
      const wait = guardNote(service, input)
      if (wait) {
        blocked ??= wait
        continue
      }
      if (service === 'Boarding' && input.plan !== 'ready') {
        endRun(run, { state: 'stopped', reason: input.plan }, input.menu, actions)
        return
      }
      status.progress = 'asking'
      run.attempt = { service, step: 'open', sinceMs: input.nowMs, hasRetried: false, hasOpened: false }
      if (input.guard.timedOut && (service === 'Boarding' || service === 'Refueling')) {
        run.entryTimedOutAtMs = input.nowMs
      }
      stepAttempt(run, input, actions)
      return
    }
  }
  if (blocked) run.note = blocked
}

/**
 * @param run The run.
 * @returns Whether every service is finished or left out.
 */
function isFinished(run: RoutineRun): boolean {
  return run.attempt === null && routineServiceRuns(run).every(({ run: status }) => isSettled(status))
}

/**
 * Moves the routine on: the request in flight, a menu GSX or the pilot opened, or the next request.
 *
 * @param run The run, changed in place.
 * @param input The step's input.
 * @param actions Where the menu actions are added.
 */
function advance(run: RoutineRun, input: RunnerInput, actions: RunnerAction[]): void {
  const isOurMenu = run.attempt !== null && (isMainMenu(input.menu) || isAdditionalServicesMenu(input.menu))
  const isForeignMenu = input.menu.menuShown && !isOurMenu
  if (run.attempt) {
    if (run.attempt.step === 'sent' || !isForeignMenu) stepAttempt(run, input, actions)
    if (isForeignMenu) stepForeignMenu(run, input, actions)
  } else if (isForeignMenu) {
    stepForeignMenu(run, input, actions)
  } else if (input.nowMs >= run.settleUntilMs) {
    startNext(run, input, actions)
  }
}

/**
 * One step of a running routine.
 *
 * @param previous The run so far; not changed.
 * @param input GSX, the aircraft, the guard and the clock.
 * @returns The run after this step, and the menu actions to send.
 */
export function stepRoutine(previous: RoutineRun, input: RunnerInput): RunnerStep {
  if (previous.outcome) return { run: previous, actions: [] }
  const run = structuredClone(previous)
  const actions: RunnerAction[] = []
  const reason = stopReasonFor(input)
  if (reason) {
    endRun(run, { state: 'stopped', reason }, input.menu, actions)
    return { run, actions }
  }
  trackServices(run, input)
  if (run.windDown) {
    stepWindDown(run, input, actions)
    return { run, actions }
  }
  run.note = restingNote(run, input)
  advance(run, input, actions)
  if (!run.outcome && isFinished(run)) endRun(run, { state: 'finished' }, input.menu, actions)
  if (
    !run.outcome &&
    input.nowMs - run.entryTimedOutAtMs < TIMEOUT_NOTE_MS &&
    run.note.code === 'following'
  ) {
    run.note = { code: 'entry-timed-out' }
  }
  return { run, actions }
}

/**
 * The pilot pressed Cancel. With abort or complete, and services of the routine's under way, the routine stays `ending` while they
 * are aborted or completed in GSX's menu (routine-winddown.ts); otherwise it stops at once.
 *
 * @param previous The run so far; not changed.
 * @param input GSX, the aircraft, the guard and the clock now: a menu the routine opened can be closed, and the services under way found.
 * @param choice What to do with the services under way; leaving them running by default.
 * @returns The run, stopped or ending, and the menu actions to send.
 */
export function cancelRoutine(
  previous: RoutineRun,
  input: RunnerInput,
  choice: GsxRoutineCancelChoice = 'leave'
): RunnerStep {
  if (previous.outcome) return { run: previous, actions: [] }
  const run = structuredClone(previous)
  const actions: RunnerAction[] = []
  if (choice !== 'leave' && !run.windDown) {
    const queue = windDownQueue(run, input, choice)
    if (queue.length > 0) {
      startWindDown(run, input, choice, queue)
      stepWindDown(run, input, actions)
      return { run, actions }
    }
  }
  endRun(run, { state: 'stopped', reason: 'cancelled' }, input.menu, actions)
  return { run, actions }
}
