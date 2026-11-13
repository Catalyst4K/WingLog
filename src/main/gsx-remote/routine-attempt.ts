/**
 * One request for one service (winglog-backend's docs/plans/gsx-service-presets.md, "Requesting one service"): open GSX's
 * menu, go one level down for the services that sit under `Additional Services ▶`, find the entry by its exact label, pick it,
 * and see GSX take it. Never two at once, and a pick is only built from the menu as it is right now.
 */
import type { GsxRemoteServiceStatus } from '@shared/ipc'
import { GSX_ADDITIONAL_SERVICES_LABEL, GSX_ROUTINE_MENU } from '@shared/gsx-routines'
import {
  findAnyEntry,
  findEntry,
  isAdditionalServicesMenu,
  isEntryDisabled,
  isMainMenu
} from './routine-menu'
import {
  adoptService,
  endRun,
  pickAction,
  serviceById,
  serviceRun,
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
 * @param input The step's input.
 * @returns Whether a menu other than the routine's own (the main menu, Additional Services) is open: GSX's follow-up question.
 */
function isFollowUpMenu(input: RunnerInput): boolean {
  return input.menu.menuShown && !isMainMenu(input.menu) && !isAdditionalServicesMenu(input.menu)
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
  const index = findAnyEntry(input.menu, GSX_ROUTINE_MENU[attempt.service].labels)
  const gsx = serviceById(input.services, attempt.service)
  if (index < 0 || isEntryDisabled(input.menu, index) || !gsx?.canTrigger) {
    skipService(run, attempt.service, 'not-offered', input, actions)
    return
  }
  actions.push(pickAction(input.menu, index))
  serviceRun(run, attempt.service).slot = {
    viaAdditionalServices: GSX_ROUTINE_MENU[attempt.service].viaAdditionalServices,
    index
  }
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
 * GSX has the service under way: follow it, end the attempt, and leave a settle window for GSX's late follow-up menus.
 *
 * @param run The run, changed in place.
 * @param attempt The attempt that asked for the service.
 * @param gsx The service as GSX shows it.
 * @param input The step's input.
 * @param actions Where a close is added.
 * @param mayHaveOpenedMenu Whether the attempt could have opened GSX's menu itself, so that menu is closed: now if it is shown, or when it
 *   opens, within MENU_OPEN_TIMEOUT_MS, if the toggle has been sent but the menu is not up yet.
 */
function adoptTaken(
  run: RoutineRun,
  attempt: Attempt,
  gsx: GsxRemoteServiceStatus,
  input: RunnerInput,
  actions: RunnerAction[],
  mayHaveOpenedMenu: boolean
): void {
  if (mayHaveOpenedMenu) {
    if (input.menu.menuShown) actions.push({ kind: 'closeMenu' })
    else if (attempt.hasOpened) run.closeOwnMenuUntilMs = input.nowMs + MENU_OPEN_TIMEOUT_MS
  }
  adoptService(run, attempt.service, gsx, input.nowMs)
  run.attempt = null
  run.settleUntilMs = input.nowMs + SETTLE_MS
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
    adoptTaken(run, attempt, gsx, input, actions, false)
    return
  }
  // GSX may hold the service back while a follow-up menu of its own (an operator to choose) runs out, and only reports it taken after
  // that menu has closed. The wait for the pick is counted from the last moment such a menu was open, so the menu is not toggled open
  // again over GSX's own.
  if (isFollowUpMenu(input)) attempt.sinceMs = input.nowMs
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
  if (attempt.step !== 'sent') {
    // GSX can take the pick after the wait for it ran out, and the retry would then find the entry relabelled and leave out a
    // service that is running.
    const gsx = serviceById(input.services, attempt.service)
    if (gsx && isTaken(gsx.state)) {
      adoptTaken(run, attempt, gsx, input, actions, true)
      return
    }
  }
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
