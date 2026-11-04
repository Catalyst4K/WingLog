/**
 * What a running GSX routine is made of (winglog-backend's docs/plans/gsx-service-presets.md, "The runner"): its state, what
 * the runner is given each step, and what it asks for in return. The step functions are in `routine-runner.ts` and
 * `routine-attempt.ts`; this file holds the shapes and the small readers both use.
 */
import type { GsxRemoteMenuState, GsxRemoteServiceStatus } from '@shared/ipc'
import type { GsxRoutine, GsxRoutineService } from '@shared/gsx-routines'
import { routineServices } from '@shared/gsx-routines'
import type {
  GsxRoutineNote,
  GsxRoutineProgress,
  GsxRoutineServiceProgress,
  GsxRoutineStopReason
} from '@shared/gsx-routine-progress'
import type { GuardResult } from './data-entry-guard'

/** Where one service of the routine is, as the runner tracks it. */
export interface ServiceRun {
  progress: 'todo' | 'asking' | 'following' | 'done' | 'skipped'
  /** Do not ask again before this time (a dropped request is asked for once more after a pause). */
  retryAtMs: number
  hasBeenDropped: boolean
  /** GSX has shown the service running at some point, so going back to `available` means it finished. */
  hasPerformed: boolean
  lastGsxState: string | undefined
}

/** One request for one service, from opening GSX's menu to GSX taking it. At most one at a time: the menu is shared. */
export interface Attempt {
  service: GsxRoutineService
  /** `open`: the menu must be opened. `submenu`: `Additional Services ▶` was picked. `sent`: the service's entry was picked. */
  step: 'open' | 'submenu' | 'sent'
  sinceMs: number
  hasRetried: boolean
  /** The menu was already asked to open, so the next step waits for it instead of toggling again. */
  hasOpened: boolean
}

export interface RoutineRun {
  routine: GsxRoutine
  services: Partial<Record<GsxRoutineService, ServiceRun>>
  attempt: Attempt | null
  /** No new request before this time: a late follow-up menu may still open after a pick. */
  settleUntilMs: number
  lastOwnPickAtMs: number
  lastFollowUpPickAtMs: number
  lastProgressAtMs: number
  /** When a data-entry timeout let a request through, for the status line. */
  entryTimedOutAtMs: number
  outcome: { state: 'finished' } | { state: 'stopped'; reason: GsxRoutineStopReason } | null
  note: GsxRoutineNote
}

/** Whether the plan is ready for Boarding to be requested (the guard needs the plan's ZFW, and GSX needs the plan to type it). */
export type PlanReadiness = 'ready' | 'gsx-has-no-plan' | 'no-planned-weight'

export interface RunnerInput {
  nowMs: number
  gsxConnected: boolean
  aircraftMoving: boolean
  menu: GsxRemoteMenuState
  services: GsxRemoteServiceStatus[]
  guard: Pick<GuardResult, 'fuelEntryOpen' | 'payloadEntryOpen' | 'fuelGapKg' | 'timedOut'>
  plan: PlanReadiness
}

/** What the driver is asked to send to GSX. A pick carries the title and label it expects, checked once more as it goes out. */
export type RunnerAction =
  { kind: 'openMenu' } | { kind: 'closeMenu' } | { kind: 'pick'; index: number; title: string; label: string }

export interface RunnerStep {
  run: RoutineRun
  actions: RunnerAction[]
}

/**
 * @param routine The routine to run.
 * @param nowMs The clock.
 * @returns A run that has asked for nothing yet.
 */
export function startRoutine(routine: GsxRoutine, nowMs: number): RoutineRun {
  const services: RoutineRun['services'] = {}
  for (const service of routineServices(routine)) {
    services[service] = {
      progress: 'todo',
      retryAtMs: 0,
      hasBeenDropped: false,
      hasPerformed: false,
      lastGsxState: undefined
    }
  }
  return {
    routine,
    services,
    attempt: null,
    settleUntilMs: 0,
    lastOwnPickAtMs: -Infinity,
    lastFollowUpPickAtMs: -Infinity,
    lastProgressAtMs: nowMs,
    entryTimedOutAtMs: -Infinity,
    outcome: null,
    note: { code: 'starting' }
  }
}

/**
 * @param services GSX's services.
 * @param id A service's id.
 * @returns That service, or undefined when GSX does not list it.
 */
export function serviceById(
  services: readonly GsxRemoteServiceStatus[],
  id: string
): GsxRemoteServiceStatus | undefined {
  return services.find((service) => service.id === id)
}

/**
 * @param run The run.
 * @param service A service of the routine.
 * @returns The service's tracking.
 * @throws When the service is not in the routine, which would be a bug in the caller.
 */
export function serviceRun(run: RoutineRun, service: GsxRoutineService): ServiceRun {
  const found = run.services[service]
  if (!found) throw new Error(`${service} is not in routine ${run.routine.name}`)
  return found
}

/**
 * @param run The run.
 * @returns Every service of the routine with where it is, in the routine's order.
 */
export function routineServiceRuns(run: RoutineRun): { service: GsxRoutineService; run: ServiceRun }[] {
  return routineServices(run.routine).map((service) => ({ service, run: serviceRun(run, service) }))
}

/**
 * @param status A service's tracking.
 * @returns Whether it is over, finished or left out.
 */
export function isSettled(status: ServiceRun): boolean {
  return status.progress === 'done' || status.progress === 'skipped'
}

const PROGRESS_FOR_SCREEN: Record<ServiceRun['progress'], GsxRoutineServiceProgress> = {
  todo: 'waiting',
  asking: 'asking',
  following: 'running',
  done: 'done',
  skipped: 'skipped'
}

/**
 * @param run The run.
 * @returns What the GSX page and the phone show: the stage it is in, each service, and the status line.
 */
export function routineProgress(run: RoutineRun): GsxRoutineProgress {
  const stages = run.routine.stages
  const firstOpenStage = stages.findIndex((stage) =>
    stage.services.some((s) => !isSettled(serviceRun(run, s)))
  )
  return {
    routineId: run.routine.id,
    routineName: run.routine.name,
    state: run.outcome?.state ?? 'running',
    stage: (firstOpenStage < 0 ? stages.length - 1 : firstOpenStage) + 1,
    stageCount: stages.length,
    services: routineServiceRuns(run).map(({ service, run: status }) => ({
      service,
      progress: PROGRESS_FOR_SCREEN[status.progress]
    })),
    note: run.note
  }
}

/**
 * @param menu The open menu.
 * @param index The entry to pick.
 * @returns A pick that carries the title and label it expects, for the driver to check as it goes out.
 */
export function pickAction(menu: GsxRemoteMenuState, index: number): RunnerAction {
  return { kind: 'pick', index, title: menu.title, label: menu.entries[index] }
}

/**
 * Follows a service GSX already has under way (or finished): not asked for again.
 *
 * @param run The run, changed in place.
 * @param service The service.
 * @param gsx GSX's view of it.
 * @param nowMs The clock.
 */
export function adoptService(
  run: RoutineRun,
  service: GsxRoutineService,
  gsx: GsxRemoteServiceStatus,
  nowMs: number
): void {
  const status = serviceRun(run, service)
  status.progress = gsx.state === 'completed' ? 'done' : 'following'
  status.lastGsxState = gsx.state
  status.hasPerformed = gsx.state === 'performing' || gsx.state === 'completing' || gsx.state === 'completed'
  run.lastProgressAtMs = nowMs
}

/**
 * Leaves a service out and carries on. A stage waiting for it stops waiting. The menu the routine opened for it is closed.
 *
 * @param run The run, changed in place.
 * @param service The service.
 * @param reason Why.
 * @param input The step's input.
 * @param actions Where a close is added.
 */
export function skipService(
  run: RoutineRun,
  service: GsxRoutineService,
  reason: 'not-offered' | 'dropped' | 'bypassed',
  input: RunnerInput,
  actions: RunnerAction[]
): void {
  serviceRun(run, service).progress = 'skipped'
  if (run.attempt?.service === service) {
    run.attempt = null
    if (input.menu.menuShown) actions.push({ kind: 'closeMenu' })
  }
  run.note = { code: 'skipped', service, reason }
  run.lastProgressAtMs = input.nowMs
}

/**
 * Ends the run. A menu the routine had opened is closed so it does not stay open on the pilot's screen.
 *
 * @param run The run, changed in place.
 * @param outcome How it ended.
 * @param menu GSX's menu now.
 * @param actions Where a close is added.
 */
export function endRun(
  run: RoutineRun,
  outcome: NonNullable<RoutineRun['outcome']>,
  menu: GsxRemoteMenuState,
  actions: RunnerAction[]
): void {
  if (run.attempt && menu.menuShown && run.attempt.step !== 'sent') actions.push({ kind: 'closeMenu' })
  run.attempt = null
  run.outcome = outcome
  run.note = outcome.state === 'finished' ? { code: 'finished' } : { code: 'stopped', reason: outcome.reason }
}
