/**
 * Requests the SimBrief plan's step climbs from BeyondATC when they come up in cruise (and a
 * level set on the FCU), so the pilot doesn't have to ask each time.
 */
import { EventEmitter } from 'node:events'
import type { ActiveTracking, BeyondAtcConnectionStatus, BeyondAtcStepClimbStatus, SimTelemetry } from '@shared/ipc'
import { logger } from '../logging/logger'
import { boxClearedLevelFt } from '@shared/atc-info-boxes'
import { requestAltitude, type AltitudeRequestSession } from './altitude-request'
import { roundLevel } from './step-climb-plan'
import {
  INITIAL_STEP_CLIMB_STATE,
  finishRequest,
  setStepClimbEnabled,
  settleRequest,
  stepClimbStatus,
  tickStepClimb,
  type StepClimbState,
  type StepClimbTarget
} from './step-climb-step'

export { extractStepPlan, type RouteFix, type StepPlan, type StepTarget } from './step-climb-plan'

/**
 * BeyondATC auto step climb (winglog-backend's docs/plans/beyondatc-auto-step-climb.md). BeyondATC only changes the cleared level
 * when the pilot asks; an aircraft left to fly its own step climbs overnight drifts out of step with it. While switched on, this
 * asks for each new level itself.
 *
 * - **Two triggers.** SimBrief's planned steps say *where* (asked for under a minute before the step point); the FCU says *when*:
 *   an aircraft's own auto step climb changes the selected altitude the moment it starts the step.
 * - **Climbs only.**
 * - **Retry once**, then drop that level and move on.
 * - The FCU alone only brings forward the **next planned step**. Any other FCU level is asked for only once the aircraft is
 *   climbing to it, so a dial-up with no climb (knob fiddling, or a level left set after a descent clearance such as 13,000 ft
 *   with the FCU still on FL400) asks for nothing.
 * - **No requests past top of descent** (SimBrief's TOD fix). A descent clearance on its own doesn't stop it: a mid-flight
 *   descent can be followed by a climb back up.
 *
 * The decision is a pure step function (step-climb-step.ts, plan and thresholds in step-climb-plan.ts); this class holds the
 * state, asks BeyondATC, writes the log lines and emits the status.
 */

export interface StepClimbDeps {
  getSession: () => (AltitudeRequestSession & { getStatus(): BeyondAtcConnectionStatus }) | undefined
  getActive: () => ActiveTracking | undefined
  getOfpJson: (flightId: number) => string | null
  request?: typeof requestAltitude
  now?: () => number
  /** Decision trail for main.log (console is routed there), so an overnight flight can be
   *  read back afterwards: why a step fired, or why it didn't. */
  log?: (message: string) => void
}

/**
 * Turns the step plan, the aircraft's position and BeyondATC's state into level requests, one tick
 * at a time, and reports what it's doing.
 */
export class StepClimbController extends EventEmitter<{ status: [BeyondAtcStepClimbStatus] }> {
  private state: StepClimbState = INITIAL_STEP_CLIMB_STATE
  private lastEmitted = ''
  private readonly request: typeof requestAltitude
  private readonly now: () => number
  private readonly writeLog: (message: string) => void

  constructor(private readonly deps: StepClimbDeps) {
    super()
    this.request = deps.request ?? requestAltitude
    this.now = deps.now ?? Date.now
    this.writeLog = (message) => (deps.log ?? ((line: string) => logger.info(line)))(`[step-climb] ${message}`)
  }

  /**
   * What the UI shows.
   *
   * @returns The step-climb status.
   */
  getStatus(): BeyondAtcStepClimbStatus {
    return stepClimbStatus(this.state)
  }

  /**
   * Switches step climb on or off.
   *
   * @param enabled The new setting.
   */
  setEnabled(enabled: boolean): void {
    const result = setStepClimbEnabled(this.state, enabled)
    this.state = result.state
    result.logs.forEach((line) => this.writeLog(line))
    this.emitStatus()
  }

  /**
   * One tick of the step-climb controller, on every telemetry update: follows the active flight, tracks
   * the FCU altitude and the climb, and, in cruise with BeyondATC connected, asks for the next level
   * when one is due.
   *
   * @param t The latest telemetry.
   */
  onTelemetry(t: SimTelemetry): void {
    if (!this.state.enabled) return
    const active = this.deps.getActive()
    const session = this.deps.getSession()
    const result = tickStepClimb(this.state, {
      t,
      now: this.now(),
      active,
      boxLevelFt: session ? boxClearedLevelFt(session.getState().infoBoxes) : null,
      isConnected: () => session?.getStatus().state === 'connected',
      getOfpJson: (flightId) => this.deps.getOfpJson(flightId)
    })
    this.state = result.state
    result.logs.forEach((line) => this.writeLog(line))
    if (result.fire && session) {
      this.emitStatus()
      this.send(session, result.fire)
    }
    this.emitStatus()
  }

  private send(session: AltitudeRequestSession, target: StepClimbTarget): void {
    const key = roundLevel(target.altitudeFt)
    const attempt = this.state.attempts[key]?.count ?? 0
    this.request(session, target.altitudeFt)
      .then(({ outcome }) => {
        const result = settleRequest(this.state, { altitudeFt: target.altitudeFt, reason: target.reason, outcome, attempt })
        this.state = result.state
        result.logs.forEach((line) => this.writeLog(line))
      })
      .catch((error: unknown) => logger.warn(`[step-climb] request ${key} ft failed: ${String(error)}`))
      .finally(() => {
        this.state = finishRequest(this.state)
        this.emitStatus()
      })
  }

  private emitStatus(): void {
    const status = this.getStatus()
    const serialised = JSON.stringify(status)
    if (serialised === this.lastEmitted) return
    this.lastEmitted = serialised
    this.emit('status', status)
  }
}
