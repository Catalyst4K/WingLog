/**
 * Connects the GSX routine runner to the real world (winglog-backend's docs/plans/gsx-service-presets.md, "Where it lives"):
 * GSX Remote's menu and services, the aircraft's telemetry and the flight's plan go into `stepRoutine` and the data-entry
 * guard, and the menu actions that come out are sent to GSX. The decisions are all in the pure step functions; this is the
 * thin wrapper around them (coding-standards.md §10), so a recorded flight can be replayed through the same code.
 *
 * It steps whenever GSX changes and twice a second besides, because the runner's timeouts need the clock to advance.
 */
import type {
  GsxRemoteCommandBar,
  GsxRemoteConnectionStatus,
  GsxRemoteMenuState,
  GsxRemoteServiceStatus,
  SimTelemetry
} from '@shared/ipc'
import type { GsxRoutine } from '@shared/gsx-routines'
import {
  GSX_ROUTINE_CANCEL_CHOICES,
  type GsxRoutineNote,
  type GsxRoutineProgress
} from '@shared/gsx-routine-progress'
import { NEW_GUARD, stepGuard, type GuardResult, type GuardState } from './data-entry-guard'
import { cancelRoutine, stepRoutine } from './routine-runner'
import {
  routineProgress,
  startRoutine,
  type PlanReadiness,
  type RoutineRun,
  type RunnerAction,
  type RunnerInput
} from './routine-run'

/** The runner's timeouts are seconds long, so half a second is often enough. */
const STEP_INTERVAL_MS = 500
/** Faster than this over the ground is the aircraft moving; the tug, a taxi. Below it is the wobble of a parked aircraft. */
const MOVING_MS = 2
/** A finished or stopped routine stays on screen this long, then the GSX page goes back to its buttons. */
const CLEAR_AFTER_END_MS = 2 * 60_000

/**
 * The status line as one line of the log: its code, and what it names.
 *
 * @param note What the routine is doing or waiting for.
 * @returns For example `waiting-for-fuel-entry (gap 85 kg)` or `skipped Catering (not-offered)`.
 */
export function describeNote(note: GsxRoutineNote): string {
  switch (note.code) {
    case 'opening-menu':
    case 'asking':
      return `${note.code} ${note.service}`
    case 'waiting-for-stage':
    case 'following':
    case 'stalled':
    case 'ending':
    case 'ending-failed':
      return note.services.length > 0 ? `${note.code} (${note.services.join(', ')})` : note.code
    case 'waiting-for-pilot':
      // GSX's menu title, quoted so that a line break or control character in it cannot start a log line of its own.
      return `${note.code} (menu ${JSON.stringify(note.menu)})`
    case 'waiting-for-fuel-entry':
      return note.gapKg === null ? note.code : `${note.code} (gap ${Math.round(note.gapKg)} kg)`
    case 'skipped':
      return `skipped ${note.service} (${note.reason})`
    default:
      return note.code
  }
}

/**
 * What makes the log write a status line again. The fuel gap is left out: while the guard holds, it moves with every kilogram the
 * APU burns, which would write a line for each one for up to fifteen minutes.
 *
 * @param note The status line.
 * @returns Equal for two notes that differ only in the fuel gap.
 */
export function noteChangeKey(note: GsxRoutineNote): string {
  return describeNote(note.code === 'waiting-for-fuel-entry' ? { ...note, gapKg: null } : note)
}

/** GSX Remote as the driver needs it: what it shows, the three menu actions, and a way to hear that anything changed. */
export interface RoutineGsx {
  getStatus(): GsxRemoteConnectionStatus
  getMenu(): GsxRemoteMenuState
  getServices(): GsxRemoteServiceStatus[]
  getCommandBar(): GsxRemoteCommandBar
  openMenuIfClosed(): boolean
  closeMenuIfOpen(): boolean
  pickMenuChecked(index: number, title: string, label: string): boolean
  /** Calls the listener after any change of status, menu, services or command bar. Returns the way to stop listening. */
  subscribe(listener: () => void): () => void
}

export interface RoutineDriverDeps {
  gsx: RoutineGsx
  telemetry: () => SimTelemetry | undefined
  /** The flight's planned zero fuel weight in kg, or null when WingLog has no plan. */
  plannedZfwKg: () => number | null
  /** Pushes the progress to every screen; null clears it. */
  publish: (progress: GsxRoutineProgress | null) => void
  logger: { info: (message: string) => void; warn: (message: string) => void }
  nowMs?: () => number
}

/** What the guard says when there is no telemetry to judge by: nothing is open. */
const NO_TELEMETRY_GUARD: Pick<GuardResult, 'fuelEntryOpen' | 'payloadEntryOpen' | 'fuelGapKg' | 'timedOut'> =
  {
    fuelEntryOpen: false,
    payloadEntryOpen: false,
    fuelGapKg: null,
    timedOut: false
  }

/** Runs one routine at a time against GSX Remote, and tells the screens how it is going. */
export class RoutineDriver {
  private run: RoutineRun | null = null
  private guard: GuardState = NEW_GUARD
  private stepTimer: NodeJS.Timeout | undefined
  private clearTimer: NodeJS.Timeout | undefined
  private unsubscribe: (() => void) | undefined
  private lastPublished = ''
  private lastNoted = ''
  private readonly nowMs: () => number

  constructor(private readonly deps: RoutineDriverDeps) {
    this.nowMs = deps.nowMs ?? Date.now
  }

  /**
   * @returns Whether a routine is running.
   */
  isRunning(): boolean {
    return this.run !== null && this.run.outcome === null
  }

  /**
   * @returns What the screens show now, or null when no routine has run lately.
   */
  getProgress(): GsxRoutineProgress | null {
    return this.run ? routineProgress(this.run) : null
  }

  /**
   * Starts a routine. Only one runs at a time: a second start while one is running does nothing.
   *
   * @param routine The routine to run.
   * @returns Whether it started.
   */
  start(routine: GsxRoutine): boolean {
    if (this.isRunning()) return false
    this.clearEnded()
    this.run = startRoutine(routine, this.nowMs())
    this.guard = NEW_GUARD
    this.lastPublished = ''
    this.lastNoted = ''
    this.deps.logger.info(`GSX routine "${routine.name}" started`)
    this.unsubscribe = this.deps.gsx.subscribe(() => this.step())
    this.stepTimer = setInterval(() => this.step(), STEP_INTERVAL_MS)
    this.step()
    return true
  }

  /**
   * The pilot pressed Cancel: the menu the routine opened is closed and the routine is gone from the screens at once, not left there
   * for CLEAR_AFTER_END_MS saying "cancelled". With abort or complete the services it has under way are first aborted or completed
   * in GSX's menu (docs/plans/gsx-routine-cancel.md), which takes a few seconds. Does nothing when no routine is running.
   *
   * @param choice What to do with the services under way; unchecked, and anything but abort or complete leaves them running.
   */
  cancel(choice?: unknown): void {
    if (!this.run || this.run.outcome) return
    const picked = GSX_ROUTINE_CANCEL_CHOICES.find((known) => known === choice)
    const step = cancelRoutine(this.run, this.readInput(), picked)
    this.apply(step.run, step.actions)
  }

  /** Stops everything and clears the screens: GSX Remote is being replaced or the app is quitting. */
  dispose(): void {
    this.stopRunning()
    this.clearEnded()
    this.run = null
    this.deps.publish(null)
  }

  /**
   * @returns The runner's input as things stand now.
   */
  private readInput(): RunnerInput {
    const { gsx } = this.deps
    const telemetry = this.deps.telemetry()
    const nowMs = this.nowMs()
    const services = gsx.getServices()
    const plannedZfwKg = this.deps.plannedZfwKg()
    let guard = NO_TELEMETRY_GUARD
    if (telemetry) {
      const result = stepGuard(this.guard, {
        nowMs,
        fuelTotalKg: telemetry.fuelTotalKg,
        totalWeightKg: telemetry.totalWeightKg,
        refueling: services.find((s) => s.id === 'Refueling'),
        boarding: services.find((s) => s.id === 'Boarding'),
        plannedZfwKg
      })
      this.guard = result.state
      guard = result
    }
    let plan: PlanReadiness = 'ready'
    if (gsx.getCommandBar().simbrief?.status === 'error') plan = 'gsx-has-no-plan'
    else if (plannedZfwKg === null) plan = 'no-planned-weight'
    return {
      nowMs,
      gsxConnected: gsx.getStatus().state === 'connected',
      aircraftMoving: (telemetry?.groundSpeedMs ?? 0) > MOVING_MS,
      menu: gsx.getMenu(),
      services,
      guard,
      plan
    }
  }

  private step(): void {
    if (!this.run || this.run.outcome) return
    const step = stepRoutine(this.run, this.readInput())
    this.apply(step.run, step.actions)
  }

  /**
   * Keeps the new run, sends what it asked of GSX, tells the screens, and winds down if the routine is over.
   *
   * @param run The run after this step.
   * @param actions The menu actions it asked for.
   */
  private apply(run: RoutineRun, actions: RunnerAction[]): void {
    this.run = run
    for (const action of actions) this.send(action)
    this.publishIfChanged()
    this.logNoteIfChanged(run)
    if (run.outcome) {
      this.deps.logger.info(
        `GSX routine "${run.routine.name}" ${run.outcome.state === 'finished' ? 'finished' : `stopped: ${run.outcome.reason}`}`
      )
      this.stopRunning()
      const isPlainCancel =
        run.outcome.state === 'stopped' && run.outcome.reason === 'cancelled' && run.note.code === 'stopped'
      if (isPlainCancel) this.clearEnded(true)
      else this.clearTimer = setTimeout(() => this.clearEnded(true), CLEAR_AFTER_END_MS)
    }
  }

  /**
   * @param action A menu action the runner asked for.
   */
  private send(action: RunnerAction): void {
    const { gsx, logger } = this.deps
    if (action.kind === 'openMenu') {
      gsx.openMenuIfClosed()
    } else if (action.kind === 'closeMenu') {
      gsx.closeMenuIfOpen()
    } else if (gsx.pickMenuChecked(action.index, action.title, action.label)) {
      logger.info(`GSX routine picked ${JSON.stringify(action.label)} in ${JSON.stringify(action.title)}`)
    } else {
      logger.warn(
        `GSX routine did not pick ${JSON.stringify(action.label)}: ${JSON.stringify(action.title)} is no longer the open menu`
      )
    }
  }

  /**
   * Writes the status line to the log each time it changes, so a routine that waits can be told from one that stopped. The end of the
   * routine has its own line.
   *
   * @param run The run after this step.
   */
  private logNoteIfChanged(run: RoutineRun): void {
    if (run.outcome) return
    const key = noteChangeKey(run.note)
    if (key === this.lastNoted) return
    this.lastNoted = key
    this.deps.logger.info(`GSX routine ${JSON.stringify(run.routine.name)}: ${describeNote(run.note)}`)
  }

  private publishIfChanged(): void {
    const progress = this.getProgress()
    const text = JSON.stringify(progress)
    if (text === this.lastPublished) return
    this.lastPublished = text
    this.deps.publish(progress)
  }

  private stopRunning(): void {
    if (this.stepTimer) clearInterval(this.stepTimer)
    this.stepTimer = undefined
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  /**
   * @param publishCleared Whether to tell the screens the progress is gone.
   */
  private clearEnded(publishCleared = false): void {
    if (this.clearTimer) clearTimeout(this.clearTimer)
    this.clearTimer = undefined
    if (!publishCleared || !this.run?.outcome) return
    this.run = null
    this.lastPublished = ''
    this.deps.publish(null)
  }
}
