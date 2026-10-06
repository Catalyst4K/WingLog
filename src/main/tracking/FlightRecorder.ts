/**
 * The flight phase machine: turns each sim tick into a phase (preflight to shutdown) and decides
 * which ticks become track points. Pure apart from the clock it's given: TrackingController owns
 * the connection and the database.
 */
import type { FlightPhase, NewTrackPoint, SimTelemetry } from '@shared/ipc'

// Thresholds are first-pass estimates (PLAN.md doesn't prescribe exact values) — expect
// to refine these after watching a few real flights track through every phase; see
// docs/simconnect-notes.md for anything that turns out surprising.
// Exported: free-flight.ts's seedPhaseFromTelemetry reuses these same two thresholds to
// seed a mid-session-started flight into the phase it would already be in had the machine
// been running the whole time, rather than inventing separate seeding-only numbers.
export const MOVING_MS = 0.5 // ~1 kt — any ground movement at all, used for pushback detection
const TAXI_SPEED_MS = 2.6 // ~5 kt — established taxi under own power vs. still being pushed
const ROLL_SPEED_MS = 18 // ~35 kt — takeoff-roll / landing-rollout boundary vs. taxi speed
export const LEVEL_VS_MS = 0.5 // ~100 fpm — vertical speed magnitude counted as "level"
const DESCENT_VS_MS = -1.0 // ~-200 fpm — sustained descent rate that ends cruise
const LEVEL_SUSTAIN_SAMPLES = 10 // consecutive 1 Hz samples of level flight to confirm cruise
const DESCENT_SUSTAIN_SAMPLES = 5 // consecutive samples of descent to confirm leaving cruise
// Consecutive airborne samples before a rollout or taxi counts as a go-around (and, the
// other way round, ground samples before 'climb'/'cruise' counts as a missed landing). One wasn't
// enough: a single airborne tick on a bouncy VHHH rollout (flight 227, 2026-10-02) went
// 'landing' -> 'climb' -> 'cruise' and recorded the whole taxi-in as cruise. Same count as
// TrackingController's MIN_AIRBORNE_SAMPLES_FOR_NEW_TOUCHDOWN, which already kept that
// bounce from being logged as a second landing.
const GO_AROUND_AIRBORNE_SAMPLES = 3
// docs/decisions.md, 2026-09-01: deviates from PLAN.md §5's "every 15s" — 5s reads better
// live without needing to keep the old marker/camera interpolation to hide the jump.
const CRUISE_TRACK_INTERVAL_S = 5
const CLIMB_TRACK_INTERVAL_S = 2 // slightly coarser than the 1s default elsewhere
// Taxi records at the same 1s as every other ground phase (no entry in shouldRecord). It was
// 3s until 2026-10: points then sat 20-60m apart, so every turn drew as a chord straight
// across the taxiway fillet. The map's own ground simplification (track-simplify.ts) keeps
// only the turns for display anyway, so the extra rows only cost storage.
// Descent from cruise altitude down to pattern altitude can be 20-40+ minutes at 1 Hz —
// the single biggest remaining point-count/CPU cost outside cruise itself, and (unlike
// climb/cruise) none of it needs to be dense: buildLandingRecord (landing-capture.ts)
// captures its metrics directly from the live telemetry tick at the descent->landing
// transition, not by re-reading track_point rows, so this reduction has zero effect on
// landing-analysis accuracy. Only applied above DESCENT_APPROACH_AGL_M — comfortably
// above where a stabilized approach begins — so the last stretch down to touchdown still
// records at full resolution for a precise visual approach/rollout trail.
const DESCENT_HIGH_ALTITUDE_INTERVAL_S = 5
const DESCENT_APPROACH_AGL_M = 500 // ~1,640 ft AGL

export interface FlightRecorderResult {
  phase: FlightPhase
  /** Present only on ticks that should actually be persisted — see downsampling above. */
  point?: NewTrackPoint
}

/**
 * Pure phase-detection + downsampling logic for one active flight. No IO — fed telemetry
 * ticks by the caller (which owns the SimConnectService subscription and persistence),
 * so this is fully unit-testable without a live sim per CLAUDE.md's testing rule.
 */
export class FlightRecorder {
  private phase: FlightPhase = 'preflight'
  private levelStreak = 0
  private descentStreak = 0
  private airborneStreak = 0
  private groundStreak = 0
  private lastPointAt: Date | undefined
  private paused = false
  // Set once, at touchdown, and never cleared — guards the taxi -> takeoff transition
  // below so a rollout/taxi-in speed blip (e.g. reverse thrust briefly pushing ground
  // speed back over ROLL_SPEED_MS) can't be mistaken for a second takeoff roll. Without
  // this the machine got permanently stuck back in 'takeoff' after landing (a real
  // overnight flight hit this, 2026-09-05) — 'takeoff' only ever exits via !onGround
  // (line below), which never happens again once truly on the ground rolling out, so the
  // flight never reached 'shutdown' and auto-completion never fired.
  private hasLanded = false
  private autoShutdown = true
  // Tags every point this recorder writes — 0 for a flight never resumed, incremented by
  // TrackingController.resume() each time the app/process restarts mid-flight (see this
  // class's own resume-parameter comment), or by bumpResumeSegment below when a
  // resume-cleanup pass finds a physically-impossible jump with no resume() involved at
  // all (flightdeck-backend's docs/plans/done/resume-track-cleanup.md — a payware aircraft's
  // own save-state/reload feature, confirmed live 2026-09-13). Never touched by the phase
  // machine itself; the map uses it to never draw a line across a spawn-point/teleport-back
  // artefact, even before any cleanup logic decides which points within a segment are
  // spurious.
  private resumeSegment = 0

  /**
   * `resume` restarts phase detection mid-flight rather than at 'preflight' — used when
   * TrackingController picks a flight's tracking back up after the app quit or crashed
   * before it reached 'shutdown' (see getActiveFlight's doc comment). Without this, a
   * resumed recorder would sit stuck at 'preflight' forever for an aircraft that's
   * actually airborne — advancePhase's 'preflight' case only transitions on `t.onGround`,
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
      this.phase = resume.phase
      this.hasLanded = resume.hasLanded
      this.resumeSegment = resume.resumeSegment
    }
  }

  /** Whether a point is on a runway, or null when that can't be known (no runway data). Only
   *  asked when ground speed passes ROLL_SPEED_MS while taxiing.
   *
   * @returns True on a runway, false off them, null when unknown.
   */
  private runwayCheck: (lat: number, lon: number) => boolean | null = () => null

  /** Injected by TrackingController from the cached runways (runway-check.ts), so a fast taxi
   *  isn't taken for the takeoff roll. Without one, the speed-only rule applies.
   *
   * @param check Whether a point (degrees) is on a runway, or null when unknown.
   */
  setRunwayCheck(check: (lat: number, lon: number) => boolean | null): void {
    this.runwayCheck = check
  }

  /**
   * "Freeze the phase machine on pause" (PLAN.md §7) — no transitions, no points, while true.
   *
   * @param paused Whether the sim is paused.
   */
  setPaused(paused: boolean): void {
    this.paused = paused
  }

  /** Settings → Tracking → "Finish flights automatically". Off, the recorder never enters
   *  'shutdown' on its own — that phase is itself what completes a flight (and what Track
   *  reads as "auto-completed"), so it mustn't be recorded at all. Finish & save still works.
   *
   * @param enabled Whether shutdown at the stand finishes the flight.
   */
  setAutoShutdown(enabled: boolean): void {
    this.autoShutdown = enabled
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
    this.resumeSegment = newSegment
  }

  getPhase(): FlightPhase {
    return this.phase
  }

  getFlightId(): number {
    return this.flightId
  }

  ingest(telemetry: SimTelemetry, nowUtc: Date): FlightRecorderResult {
    // "Ignore samples while IS SLEW ACTIVE" (PLAN.md §7) — slewing teleports the aircraft,
    // which would otherwise read as a physically impossible speed/phase jump.
    if (this.paused || telemetry.slewActive) {
      return { phase: this.phase }
    }

    this.advancePhase(telemetry)

    if (!this.shouldRecord(telemetry, nowUtc)) {
      return { phase: this.phase }
    }

    this.lastPointAt = nowUtc
    return { phase: this.phase, point: this.toTrackPoint(telemetry, nowUtc) }
  }

  /**
   * One tick of the phase machine: the current phase's own transition, then auto-shutdown.
   *
   * @param t This tick.
   */
  private advancePhase(t: SimTelemetry): void {
    switch (this.phase) {
      case 'preflight':
        if (t.onGround && (t.groundSpeedMs > MOVING_MS || t.engineCombustion1)) this.phase = 'pushback'
        break
      case 'pushback':
        if (t.groundSpeedMs > TAXI_SPEED_MS) this.phase = 'taxi'
        break
      case 'taxi':
        this.fromTaxi(t)
        break
      case 'takeoff':
        this.fromTakeoff(t)
        break
      case 'climb':
        this.fromClimb(t)
        break
      case 'cruise':
        this.fromCruise(t)
        break
      case 'descent':
        this.fromDescent(t)
        break
      case 'landing':
        this.fromLanding(t)
        break
      case 'shutdown':
        break
    }
    this.shutDownIfParked(t)
  }

  /**
   * From 'taxi': a go-around, or the takeoff roll.
   *
   * @param t This tick.
   */
  private fromTaxi(t: SimTelemetry): void {
    // A genuine go-around/touch-and-go — the aircraft is actually airborne again, not
    // just a rollout groundspeed blip (that case never leaves the ground) — goes
    // straight back to 'climb', same as 'landing'. Checked before the hasLanded-guarded
    // branch so a real second departure is never mistaken for the rollout noise that
    // guard exists to block.
    if (this.goneAround(t)) return
    // Only on a runway, when that's known: a fast taxi along a parallel taxiway isn't the
    // takeoff roll (flight 230, VHHH).
    if (!this.hasLanded && t.groundSpeedMs > ROLL_SPEED_MS && this.runwayCheck(t.latitude, t.longitude) !== false) {
      this.phase = 'takeoff'
    }
  }

  /**
   * From 'landing': slowed to taxi speed, or a go-around (a rejected landing or touch-and-go
   * that never slowed through ROLL_SPEED_MS), as from 'taxi'.
   *
   * @param t This tick.
   */
  private fromLanding(t: SimTelemetry): void {
    if (!this.goneAround(t) && t.groundSpeedMs < ROLL_SPEED_MS) this.phase = 'taxi'
  }

  /**
   * From 'takeoff': airborne, or a rejected takeoff back to 'taxi'.
   *
   * @param t This tick.
   */
  private fromTakeoff(t: SimTelemetry): void {
    // A rejected takeoff — aborted before ever leaving the ground — has no way back to
    // 'taxi' without the speed check: the only other exit is !t.onGround, which never happens
    // if the aircraft decelerates and taxis back instead of departing. Mirrors 'landing'.
    if (!t.onGround) {
      this.phase = 'climb'
      return
    }
    if (t.groundSpeedMs < ROLL_SPEED_MS) this.phase = 'taxi'
  }

  /**
   * From 'climb': level for long enough is cruise.
   *
   * @param t This tick.
   */
  private fromClimb(t: SimTelemetry): void {
    if (this.backOnGround(t)) return
    this.levelStreak = Math.abs(t.verticalSpeedMs) < LEVEL_VS_MS ? this.levelStreak + 1 : 0
    if (this.levelStreak >= LEVEL_SUSTAIN_SAMPLES) {
      this.phase = 'cruise'
      this.levelStreak = 0
    }
  }

  /**
   * From 'cruise': descending for long enough is descent.
   *
   * @param t This tick.
   */
  private fromCruise(t: SimTelemetry): void {
    if (this.backOnGround(t)) return
    this.descentStreak = t.verticalSpeedMs < DESCENT_VS_MS ? this.descentStreak + 1 : 0
    if (this.descentStreak >= DESCENT_SUSTAIN_SAMPLES) {
      this.phase = 'descent'
      this.descentStreak = 0
      this.levelStreak = 0
    }
  }

  /**
   * From 'descent': touchdown is landing; levelling off again is back to cruise.
   *
   * @param t This tick.
   */
  private fromDescent(t: SimTelemetry): void {
    // Matches the touchdown detection: the on-ground false→true transition.
    if (t.onGround) {
      this.phase = 'landing'
      this.hasLanded = true
      return
    }
    // A routine flight-level step-down sustains a descent rate for well over
    // DESCENT_SUSTAIN_SAMPLES too, so without this a level-off afterwards would leave
    // the flight stuck recording as "descent" all the way to touchdown.
    this.levelStreak = Math.abs(t.verticalSpeedMs) < LEVEL_VS_MS ? this.levelStreak + 1 : 0
    if (this.levelStreak >= LEVEL_SUSTAIN_SAMPLES) {
      this.phase = 'cruise'
      this.levelStreak = 0
    }
  }

  /**
   * Taxiing after landing, stopped with the parking brake set and the engines off: shutdown.
   * Only from the post-landing 'taxi' phase: the same state in 'preflight' drives pushback
   * instead, so "not yet started" and "shut down" can't be confused.
   *
   * @param t This tick.
   */
  private shutDownIfParked(t: SimTelemetry): void {
    if (this.autoShutdown && this.phase === 'taxi' && t.groundSpeedMs < MOVING_MS && t.parkingBrakeOn && !t.engineCombustion1) {
      this.phase = 'shutdown'
    }
  }

  /** 'landing'/'taxi' -> 'climb' only once airborne for GO_AROUND_AIRBORNE_SAMPLES in a row;
   *  true while airborne at all, so the caller skips its on-the-ground checks.
   *
   * @param t This tick.
   * @returns Whether the aircraft is airborne.
   */
  private goneAround(t: SimTelemetry): boolean {
    if (t.onGround) {
      this.airborneStreak = 0
      return false
    }
    this.airborneStreak += 1
    if (this.airborneStreak >= GO_AROUND_AIRBORNE_SAMPLES) {
      this.phase = 'climb'
      this.airborneStreak = 0
      this.levelStreak = 0
    }
    return true
  }

  /** On the ground in 'climb'/'cruise' for GO_AROUND_AIRBORNE_SAMPLES in a row: a landing
   *  the machine missed. A bounce that outlasted the go-around check, a flight resumed in
   *  that state (flight 227's own last point), or a circuit that touched down straight from
   *  'climb' without ever reaching 'descent' (flight 198, VHHH). Back to 'landing', which
   *  reaches 'taxi' on speed as usual; one tick back on the runway just after liftoff is
   *  left alone.
   *
   * @param t This tick.
   * @returns Whether the phase went back to 'landing'.
   */
  private backOnGround(t: SimTelemetry): boolean {
    if (!t.onGround) {
      this.groundStreak = 0
      return false
    }
    this.groundStreak += 1
    if (this.groundStreak < GO_AROUND_AIRBORNE_SAMPLES) return false
    this.phase = 'landing'
    this.hasLanded = true
    this.groundStreak = 0
    this.levelStreak = 0
    this.descentStreak = 0
    return true
  }

  private shouldRecord(t: SimTelemetry, nowUtc: Date): boolean {
    if (!this.lastPointAt) return true
    const elapsedS = (nowUtc.getTime() - this.lastPointAt.getTime()) / 1000
    let interval = 1
    if (this.phase === 'cruise') interval = CRUISE_TRACK_INTERVAL_S
    else if (this.phase === 'climb') interval = CLIMB_TRACK_INTERVAL_S
    else if (this.phase === 'descent' && t.altitudeAglM > DESCENT_APPROACH_AGL_M) {
      interval = DESCENT_HIGH_ALTITUDE_INTERVAL_S
    }
    return elapsedS >= interval
  }

  private toTrackPoint(t: SimTelemetry, nowUtc: Date): NewTrackPoint {
    return {
      flightId: this.flightId,
      tsUtc: nowUtc.toISOString(),
      latitude: t.latitude,
      longitude: t.longitude,
      altitudeM: t.altitudeM,
      pressureAltitudeM: t.pressureAltitudeM,
      altitudeAglM: t.altitudeAglM,
      indicatedAirspeedMs: t.indicatedAirspeedMs,
      machSpeed: t.machSpeed,
      groundSpeedMs: t.groundSpeedMs,
      verticalSpeedMs: t.verticalSpeedMs,
      headingTrueDeg: t.headingTrueDeg,
      pitchDeg: t.pitchDeg,
      bankDeg: t.bankDeg,
      phase: this.phase,
      onGround: t.onGround,
      fuelKg: t.fuelTotalKg,
      gForce: t.gForce,
      windSpeedMs: t.windSpeedMs,
      windDirectionDeg: t.windDirectionDeg,
      resumeSegment: this.resumeSegment,
      simRate: t.simRate,
      excludedReason: null
    }
  }
}
