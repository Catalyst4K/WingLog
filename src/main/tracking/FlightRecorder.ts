/**
 * The flight phase machine: turns each sim tick into a phase (preflight to shutdown) and decides
 * which ticks become track points. Pure apart from the clock it's given: TrackingController owns
 * the connection and the database.
 */
import type { FlightPhase, NewTrackPoint, SimTelemetry } from '@shared/ipc'
import {
  INITIAL_PHASE_STATE,
  buildTrackPoint,
  stepPhase,
  type PhaseSettings,
  type PhaseState
} from './flight-phase-step'

export { LEVEL_VS_MS, MOVING_MS } from './flight-phase-step'

export interface FlightRecorderResult {
  phase: FlightPhase
  /** Present only on ticks that should actually be persisted — see downsampling in flight-phase-step.ts. */
  point?: NewTrackPoint
}

/**
 * Phase-detection + downsampling for one active flight. No IO — fed telemetry ticks by the caller (which owns the
 * SimConnectService subscription and persistence), so this is fully unit-testable without a live sim per CLAUDE.md's testing
 * rule. The rules are in flight-phase-step.ts (a pure step function); this class holds the state and the switches, and builds the
 * track point.
 */
export class FlightRecorder {
  private state: PhaseState = INITIAL_PHASE_STATE
  private readonly settings: PhaseSettings = { paused: false, autoShutdown: true, runwayCheck: () => null }

  /**
   * `resume` restarts phase detection mid-flight rather than at 'preflight' — used when
   * TrackingController picks a flight's tracking back up after the app quit or crashed
   * before it reached 'shutdown' (the prompt main shows at startup). Without this, a
   * resumed recorder would sit stuck at 'preflight' forever for an aircraft that's
   * actually airborne — the 'preflight' case only transitions on `t.onGround`,
   * which never becomes true again mid-flight. `phase` comes from the flight's last
   * persisted track_point (each point records the phase it was captured in); `hasLanded`
   * from whether the flight row already has an actual_on_utc; `resumeSegment` is one more
   * than the last persisted point's own segment (0 if there were no prior points at all).
   *
   * @param flightId The flight being recorded.
   * @param resume Where to pick up after a restart: the phase, whether it has landed, the next track segment.
   */
  constructor(
    private readonly flightId: number,
    resume?: { phase: FlightPhase; hasLanded: boolean; resumeSegment: number }
  ) {
    if (resume) {
      this.state = { ...INITIAL_PHASE_STATE, phase: resume.phase, hasLanded: resume.hasLanded, resumeSegment: resume.resumeSegment }
    }
  }

  /** Injected by TrackingController from the cached runways (runway-check.ts), so a fast taxi
   *  isn't taken for the takeoff roll. Without one, the speed-only rule applies.
   *
   * @param check Whether a point (degrees) is on a runway, or null when unknown.
   */
  setRunwayCheck(check: (lat: number, lon: number) => boolean | null): void {
    this.settings.runwayCheck = check
  }

  /**
   * "Freeze the phase machine on pause" (PLAN.md §7) — no transitions, no points, while true.
   *
   * @param paused Whether the sim is paused.
   */
  setPaused(paused: boolean): void {
    this.settings.paused = paused
  }

  /** Settings → Tracking → "Finish flights automatically". Off, the recorder never enters
   *  'shutdown' on its own — that phase is itself what completes a flight (and what Track
   *  reads as "auto-completed"), so it mustn't be recorded at all. Finish & save still works.
   *
   * @param enabled Whether shutdown at the stand finishes the flight.
   */
  setAutoShutdown(enabled: boolean): void {
    this.settings.autoShutdown = enabled
  }

  /** Called by TrackingController the moment a live resume-cleanup check finds a
   *  physically-impossible jump with no resume window open (checkForLiveJump) — every
   *  point from here on needs the new segment too, not just the one(s) the cleanup pass
   *  could already see when it ran. Without this, points recorded after the jump but
   *  before the next one would keep stamping the stale segment, splitting what should be
   *  one continuous new segment in two.
   *
   * @param newSegment The segment for every point from now on.
   */
  bumpResumeSegment(newSegment: number): void {
    this.state = { ...this.state, resumeSegment: newSegment }
  }

  /**
   * The phase now.
   *
   * @returns The current phase.
   */
  getPhase(): FlightPhase {
    return this.state.phase
  }

  /**
   * The flight being recorded.
   *
   * @returns The flight id.
   */
  getFlightId(): number {
    return this.flightId
  }

  /**
   * One sim tick.
   *
   * @param telemetry The tick.
   * @param nowUtc When it was received.
   * @returns The phase after it, and the track point when this tick is recorded.
   */
  ingest(telemetry: SimTelemetry, nowUtc: Date): FlightRecorderResult {
    const step = stepPhase(this.state, telemetry, nowUtc.getTime(), this.settings)
    this.state = step.state
    return step.record
      ? { phase: this.state.phase, point: buildTrackPoint(this.flightId, this.state, telemetry, nowUtc) }
      : { phase: this.state.phase }
  }
}
