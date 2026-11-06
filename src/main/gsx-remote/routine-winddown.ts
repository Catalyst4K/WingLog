/**
 * Cancel with a choice for the services under way (winglog-backend's docs/plans/gsx-routine-cancel.md): each is aborted or completed
 * through GSX's own menu, one at a time, then the routine ends as cancelled. A pure step function like the rest of the runner.
 *
 * While a service runs GSX relabels its entry in the menu, and picking that entry opens `Service in progress` (`Complete now`,
 * `Abort service`, `Back`), which does not say which service it is for. So the entry is found at the position the routine's own
 * request picked it from (`ServiceRun.slot`), must no longer be a `Request …` entry, and `Abort service` or `Complete now` are only
 * picked on a menu titled exactly `Service in progress`.
 */
import { GSX_ADDITIONAL_SERVICES_LABEL, type GsxRoutineService } from '@shared/gsx-routines'
import type { GsxRoutineCancelChoice } from '@shared/gsx-routine-progress'
import {
  ABORT_SERVICE_LABEL,
  COMPLETE_NOW_LABEL,
  findEntry,
  isAdditionalServicesMenu,
  isEntryDisabled,
  isMainMenu,
  isServiceInProgressMenu
} from './routine-menu'
import {
  endRun,
  pickAction,
  routineServiceRuns,
  serviceById,
  serviceRun,
  type RoutineRun,
  type RunnerAction,
  type RunnerInput,
  type WindDown
} from './routine-run'

/** Each step gets this long (opening the menu, the entry's menu, GSX acting on the pick) before the service is left as it is. */
const STEP_TIMEOUT_MS = 10_000
/** An entry whose label still starts like this is a service that is not running: it is never picked as a running service. */
const REQUEST_LABEL_PREFIX = 'Request '

/**
 * @param choice Abort or complete.
 * @returns The GSX service states the choice still has something to do with.
 */
function statesToAct(choice: WindDown['choice']): string[] {
  return choice === 'abort' ? ['requested', 'performing', 'completing'] : ['requested', 'performing']
}

/**
 * @param run The run.
 * @param input The step's input.
 * @param choice What Cancel was asked to do.
 * @returns The routine's own services GSX has under way that a choice has something to do with, in the routine's order. A service
 *   the routine did not ask for itself (no slot) is not among them.
 */
export function windDownQueue(
  run: RoutineRun,
  input: RunnerInput,
  choice: Exclude<GsxRoutineCancelChoice, 'leave'>
): GsxRoutineService[] {
  const states = statesToAct(choice)
  return routineServiceRuns(run)
    .filter(({ service, run: status }) => {
      const gsx = serviceById(input.services, service)
      return status.slot !== null && gsx !== undefined && states.includes(gsx.state)
    })
    .map(({ service }) => service)
}

/**
 * Starts the wind-down: the request in flight is dropped (a menu it opened is reused), and the routine is `ending` until it is done.
 *
 * @param run The run, changed in place.
 * @param input The step's input.
 * @param choice Abort or complete.
 * @param queue The services to do (windDownQueue).
 */
export function startWindDown(
  run: RoutineRun,
  input: RunnerInput,
  choice: WindDown['choice'],
  queue: GsxRoutineService[]
): void {
  run.attempt = null
  run.windDown = { choice, queue, step: 'open', sinceMs: input.nowMs, hasOpened: false, failed: [] }
  run.note = { code: 'ending', choice, services: queue }
}

/**
 * @param menu GSX's menu.
 * @returns Whether it is one the wind-down itself opens, so closing it leaves nothing of the pilot's open.
 */
function isOurMenu(menu: RunnerInput['menu']): boolean {
  return isMainMenu(menu) || isAdditionalServicesMenu(menu) || isServiceInProgressMenu(menu)
}

/**
 * Moves on to the next service, and notes the one just done with.
 *
 * @param windDown The wind-down, changed in place.
 * @param input The step's input.
 * @param failed Whether the service was left as it is.
 */
function moveOn(windDown: WindDown, input: RunnerInput, failed: boolean): void {
  const service = windDown.queue.shift()
  if (failed && service) windDown.failed.push(service)
  windDown.step = 'open'
  windDown.hasOpened = false
  windDown.sinceMs = input.nowMs
}

/**
 * Picks the service's own entry on the menu that holds it, if it is no longer a `Request …` entry.
 *
 * @param run The run, changed in place.
 * @param windDown The wind-down.
 * @param service The service being done.
 * @param input The step's input.
 * @param actions Where the pick is added.
 */
function pickOwnEntry(
  run: RoutineRun,
  windDown: WindDown,
  service: GsxRoutineService,
  input: RunnerInput,
  actions: RunnerAction[]
): void {
  const slot = serviceRun(run, service).slot
  const label = slot ? input.menu.entries[slot.index] : undefined
  if (
    !slot ||
    label === undefined ||
    label.startsWith(REQUEST_LABEL_PREFIX) ||
    isEntryDisabled(input.menu, slot.index)
  ) {
    if (isOurMenu(input.menu)) actions.push({ kind: 'closeMenu' })
    moveOn(windDown, input, true)
    return
  }
  actions.push(pickAction(input.menu, slot.index))
  windDown.step = 'choose'
  windDown.sinceMs = input.nowMs
}

/**
 * A menu is open: the main menu holds the service's entry, or `Additional Services ▶` for one a level down.
 *
 * @param run The run, changed in place.
 * @param windDown The wind-down.
 * @param service The service being done.
 * @param input The step's input.
 * @param actions Where the pick is added.
 */
function openedMenu(
  run: RoutineRun,
  windDown: WindDown,
  service: GsxRoutineService,
  input: RunnerInput,
  actions: RunnerAction[]
): void {
  const isDeeper = serviceRun(run, service).slot?.viaAdditionalServices === true
  if (isMainMenu(input.menu) && !isDeeper) {
    pickOwnEntry(run, windDown, service, input, actions)
  } else if (isMainMenu(input.menu)) {
    const index = findEntry(input.menu, GSX_ADDITIONAL_SERVICES_LABEL)
    if (index < 0 || isEntryDisabled(input.menu, index)) {
      actions.push({ kind: 'closeMenu' })
      moveOn(windDown, input, true)
      return
    }
    actions.push(pickAction(input.menu, index))
    windDown.step = 'submenu'
    windDown.sinceMs = input.nowMs
  } else if (isAdditionalServicesMenu(input.menu) && isDeeper) {
    pickOwnEntry(run, windDown, service, input, actions)
  } else if (isOurMenu(input.menu)) {
    // One of the routine's own menus, but not the one this step needs (left from the request in flight): closed, then opened afresh.
    actions.push({ kind: 'closeMenu' })
    windDown.hasOpened = false
  }
}

/**
 * `Service in progress` is open: Abort service or Complete now, by exact label.
 *
 * @param windDown The wind-down.
 * @param input The step's input.
 * @param actions Where the pick is added.
 */
function chooseOnServiceMenu(windDown: WindDown, input: RunnerInput, actions: RunnerAction[]): void {
  const index = findEntry(input.menu, windDown.choice === 'abort' ? ABORT_SERVICE_LABEL : COMPLETE_NOW_LABEL)
  if (index < 0 || isEntryDisabled(input.menu, index)) {
    actions.push({ kind: 'closeMenu' })
    moveOn(windDown, input, true)
    return
  }
  actions.push(pickAction(input.menu, index))
  windDown.step = 'wait'
  windDown.sinceMs = input.nowMs
}

/**
 * Every service is done: the routine ends as cancelled, with a note of any that was left as it is.
 *
 * @param run The run, changed in place.
 * @param windDown The wind-down.
 * @param input The step's input.
 * @param actions Where a close is added.
 */
function finishWindDown(
  run: RoutineRun,
  windDown: WindDown,
  input: RunnerInput,
  actions: RunnerAction[]
): void {
  if (isOurMenu(input.menu)) actions.push({ kind: 'closeMenu' })
  run.windDown = null
  endRun(run, { state: 'stopped', reason: 'cancelled' }, input.menu, actions)
  if (windDown.failed.length > 0) run.note = { code: 'ending-failed', services: windDown.failed }
}

/**
 * One step of the wind-down. When every service is done the routine ends as cancelled, with a note of any that was left as it is.
 *
 * @param run The run, changed in place.
 * @param input The step's input.
 * @param actions Where menu actions are added.
 */
export function stepWindDown(run: RoutineRun, input: RunnerInput, actions: RunnerAction[]): void {
  const windDown = run.windDown
  if (!windDown) return
  const service = windDown.queue[0]
  if (!service) {
    finishWindDown(run, windDown, input, actions)
    return
  }
  const gsx = serviceById(input.services, service)
  if (!gsx || !statesToAct(windDown.choice).includes(gsx.state)) {
    // Done: aborted or completed, or it finished by itself.
    moveOn(windDown, input, false)
  } else if (input.nowMs - windDown.sinceMs >= STEP_TIMEOUT_MS) {
    if (isOurMenu(input.menu)) actions.push({ kind: 'closeMenu' })
    moveOn(windDown, input, true)
  } else if (windDown.step === 'open' || windDown.step === 'submenu') {
    if (input.menu.menuShown) openedMenu(run, windDown, service, input, actions)
    else if (!windDown.hasOpened) {
      actions.push({ kind: 'openMenu' })
      windDown.hasOpened = true
      windDown.sinceMs = input.nowMs
    }
  } else if (windDown.step === 'choose' && isServiceInProgressMenu(input.menu)) {
    chooseOnServiceMenu(windDown, input, actions)
  }
  if (run.windDown) run.note = { code: 'ending', choice: windDown.choice, services: [...windDown.queue] }
}
