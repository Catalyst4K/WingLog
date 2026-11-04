/**
 * One request for one service (winglog-backend's docs/plans/gsx-service-presets.md, "Requesting one service"): open GSX's
 * menu, go one level down for the services that sit under `Additional Services ▶`, find the entry by its exact label, pick it,
 * and see GSX take it. Never two at once, and a pick is only built from the menu as it is right now.
 */
import { GSX_ADDITIONAL_SERVICES_LABEL, GSX_ROUTINE_MENU } from '@shared/gsx-routines'
import { findEntry, isAdditionalServicesMenu, isEntryDisabled, isMainMenu } from './routine-menu'
import {
  adoptService,
  endRun,
  pickAction,
  serviceById,
  skipService,
  type Attempt,
  type RoutineRun,
  type RunnerAction,
  type RunnerInput
} from './routine-run'

/** How long GSX gets to open its menu, or to show the submenu, before the routine tries once more. */
const MENU_OPEN_TIMEOUT_MS = 5_000
/** How long GSX gets to take a pick before the routine asks once more. */
const PICK_TIMEOUT_MS = 5_000
/** After a pick, wait this long before the next request: a late follow-up menu may still open. */
export const SETTLE_MS = 2_000

/**
 * @param state A GSX service state.
 * @returns Whether GSX has taken the request.
 */
function isTaken(state: string): boolean {
  return state === 'requested' || state === 'performing' || state === 'completing' || state === 'completed'
}

/**
 * Tries the step again once, then gives up the whole routine: a menu that will not open means GSX is not answering.
 *
 * @param run The run, changed in place.
 * @param attempt The attempt.
 * @param input The step's input.
 * @param actions Where a close is added.
 */
function retryOnceOrStop(
  run: RoutineRun,
  attempt: Attempt,
  input: RunnerInput,
  actions: RunnerAction[]
): void {
  if (attempt.hasRetried) {
    endRun(run, { state: 'stopped', reason: 'menu-failed' }, input.menu, actions)
    return
  }
  attempt.hasRetried = true
  attempt.hasOpened = false
  attempt.step = 'open'
  attempt.sinceMs = input.nowMs
}

/**
 * Picks the service's entry on the menu that should hold it. Skips the service when its label is missing or greyed out, or
 * when GSX does not list it as available and triggerable.
 *
 * @param run The run, changed in place.
 * @param attempt The attempt.
 * @param input The step's input.
 * @param actions Where the pick is added.
 */
function requestOnMenu(run: RoutineRun, attempt: Attempt, input: RunnerInput, actions: RunnerAction[]): void {
  const index = findEntry(input.menu, GSX_ROUTINE_MENU[attempt.service].label)
  const gsx = serviceById(input.services, attempt.service)
  if (index < 0 || isEntryDisabled(input.menu, index) || !gsx?.canTrigger) {
    skipService(run, attempt.service, 'not-offered', input, actions)
    return
  }
  actions.push(pickAction(input.menu, index))
  attempt.step = 'sent'
  attempt.sinceMs = input.nowMs
  run.lastOwnPickAtMs = input.nowMs
}

/**
 * The main menu is open: pick the service, or `Additional Services ▶` first for a service one level down.
 *
 * @param run The run, changed in place.
 * @param attempt The attempt.
 * @param input The step's input.
 * @param actions Where the pick is added.
 */
function chooseOnMainMenu(
  run: RoutineRun,
  attempt: Attempt,
  input: RunnerInput,
  actions: RunnerAction[]
): void {
  if (!GSX_ROUTINE_MENU[attempt.service].viaAdditionalServices) {
    requestOnMenu(run, attempt, input, actions)
    return
  }
  const index = findEntry(input.menu, GSX_ADDITIONAL_SERVICES_LABEL)
  if (index < 0 || isEntryDisabled(input.menu, index)) {
    skipService(run, attempt.service, 'not-offered', input, actions)
    return
  }
  actions.push(pickAction(input.menu, index))
  attempt.step = 'submenu'
  attempt.sinceMs = input.nowMs
}

/**
 * Waits for GSX to take the pick. A request GSX did not take in time is asked for once more, then left out.
 *
 * @param run The run, changed in place.
 * @param attempt The attempt.
 * @param input The step's input.
 * @param actions Where a close is added.
 */
function waitForGsxToTakeIt(
  run: RoutineRun,
  attempt: Attempt,
  input: RunnerInput,
  actions: RunnerAction[]
): void {
  const gsx = serviceById(input.services, attempt.service)
  if (gsx && isTaken(gsx.state)) {
    adoptService(run, attempt.service, gsx, input.nowMs)
    run.attempt = null
    run.settleUntilMs = input.nowMs + SETTLE_MS
    return
  }
  if (input.nowMs - attempt.sinceMs < PICK_TIMEOUT_MS) return
  if (attempt.hasRetried) skipService(run, attempt.service, 'dropped', input, actions)
  else retryOnceOrStop(run, attempt, input, actions)
}

/**
 * One step of the attempt in progress. Called when the menu on screen is the routine's own or is closed; a menu the pilot or
 * GSX opened is handled by the runner first.
 *
 * @param run The run, changed in place.
 * @param input The step's input.
 * @param actions Where menu actions are added.
 */
export function stepAttempt(run: RoutineRun, input: RunnerInput, actions: RunnerAction[]): void {
  const attempt = run.attempt
  if (!attempt) return
  stepAttemptOnce(run, attempt, input, actions)
  // The status line follows the step the attempt is in now: the menu is still opening until a pick has been made.
  if (run.attempt) {
    run.note =
      run.attempt.step === 'open'
        ? { code: 'opening-menu', service: run.attempt.service }
        : { code: 'asking', service: run.attempt.service }
  }
}

/**
 * @param run The run, changed in place.
 * @param attempt The attempt in progress.
 * @param input The step's input.
 * @param actions Where menu actions are added.
 */
function stepAttemptOnce(
  run: RoutineRun,
  attempt: Attempt,
  input: RunnerInput,
  actions: RunnerAction[]
): void {
  if (attempt.step === 'sent') {
    waitForGsxToTakeIt(run, attempt, input, actions)
  } else if (attempt.step === 'submenu') {
    if (isAdditionalServicesMenu(input.menu)) requestOnMenu(run, attempt, input, actions)
    else if (input.nowMs - attempt.sinceMs >= MENU_OPEN_TIMEOUT_MS)
      retryOnceOrStop(run, attempt, input, actions)
  } else if (isMainMenu(input.menu)) {
    chooseOnMainMenu(run, attempt, input, actions)
  } else if (!attempt.hasOpened) {
    actions.push({ kind: 'openMenu' })
    attempt.hasOpened = true
    attempt.sinceMs = input.nowMs
  } else if (input.nowMs - attempt.sinceMs >= MENU_OPEN_TIMEOUT_MS) {
    retryOnceOrStop(run, attempt, input, actions)
  }
}
