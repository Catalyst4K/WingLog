/**
 * What a running GSX routine reports (winglog-backend's docs/plans/gsx-service-presets.md, "UI"): the live topic `gsxRoutine`,
 * shown on the GSX page and on the phone. The status is a code and its values, never a sentence, so each screen words it in
 * its own language.
 */
import type { GsxRoutineService } from './gsx-routines'

/** Where one service of the routine is. */
export type GsxRoutineServiceProgress = 'waiting' | 'asking' | 'running' | 'done' | 'skipped'

/** Why a routine stopped before it finished. */
export type GsxRoutineStopReason =
  | 'cancelled'
  | 'gsx-disconnected'
  | 'aircraft-moved'
  | 'departure'
  | 'menu-failed'
  | 'gsx-has-no-plan'
  | 'no-planned-weight'

/** What Cancel does with the services the routine has under way (winglog-backend's docs/plans/gsx-routine-cancel.md): GSX's own `Abort
 *  service` or `Complete now` on each, or nothing. */
export type GsxRoutineCancelChoice = 'abort' | 'complete' | 'leave'

/** Every choice, for checking one that arrived from outside. */
export const GSX_ROUTINE_CANCEL_CHOICES: readonly GsxRoutineCancelChoice[] = ['abort', 'complete', 'leave']

/** Why a service was left out. */
export type GsxRoutineSkipReason = 'not-offered' | 'dropped' | 'bypassed'

/** The status line: what the routine is doing or waiting for right now. */
export type GsxRoutineNote =
  | { code: 'starting' }
  | { code: 'opening-menu'; service: GsxRoutineService }
  | { code: 'asking'; service: GsxRoutineService }
  | { code: 'waiting-for-stage'; services: GsxRoutineService[] }
  | { code: 'waiting-for-pilot'; menu: string }
  | { code: 'waiting-for-fuel-entry'; gapKg: number | null }
  | { code: 'waiting-for-payload-entry' }
  | { code: 'entry-timed-out' }
  | { code: 'following'; services: GsxRoutineService[] }
  | { code: 'stalled'; services: GsxRoutineService[] }
  | { code: 'skipped'; service: GsxRoutineService; reason: GsxRoutineSkipReason }
  /** Cancel was pressed with a choice for the services under way: they are being aborted or completed in GSX's menu, one at a time. */
  | { code: 'ending'; choice: 'abort' | 'complete'; services: GsxRoutineService[] }
  /** The routine is cancelled, but these could not be reached in GSX's menu in time, so they were left as they are. */
  | { code: 'ending-failed'; services: GsxRoutineService[] }
  | { code: 'finished' }
  | { code: 'stopped'; reason: GsxRoutineStopReason }

export interface GsxRoutineProgress {
  routineId: string
  routineName: string
  /** `running` until every service is done or skipped (`finished`), or the routine stops (`stopped`). */
  state: 'running' | 'finished' | 'stopped'
  /** The stage the routine is in, from 1. */
  stage: number
  stageCount: number
  services: { service: GsxRoutineService; progress: GsxRoutineServiceProgress }[]
  note: GsxRoutineNote
}
