import type { FlightPhase, NewTrackPoint, SimTelemetry } from '@shared/ipc'

// Thresholds are first-pass estimates (PLAN.md doesn't prescribe exact values) — expect
// to refine these after watching a few real flights track through every phase; see
// docs/simconnect-notes.md for anything that turns out surprising.
const MOVING_MS = 0.5 // ~1 kt — any ground movement at all, used for pushback detection
const TAXI_SPEED_MS = 2.6 // ~5 kt — established taxi under own power vs. still being pushed
const ROLL_SPEED_MS = 18 // ~35 kt — takeoff-roll / landing-rollout boundary vs. taxi speed
const LEVEL_VS_MS = 0.5 // ~100 fpm — vertical speed magnitude counted as "level"
const DESCENT_VS_MS = -1.0 // ~-200 fpm — sustained descent rate that ends cruise
const LEVEL_SUSTAIN_SAMPLES = 10 // consecutive 1 Hz samples of level flight to confirm cruise
const DESCENT_SUSTAIN_SAMPLES = 5 // consecutive samples of descent to confirm leaving cruise
// docs/decisions.md, 2026-09-01: deviates from PLAN.md §5's "every 15s" — 5s reads better
// live without needing to keep the old marker/camera interpolation to hide the jump.
const CRUISE_TRACK_INTERVAL_S = 5
const CLIMB_TRACK_INTERVAL_S = 2 // slightly coarser than the 1s default elsewhere
// Ground movement between the runway and the gate — slow, and nothing about it needs
// landing-analysis-grade precision, so it's worth the same treatment as cruise (a big
// hub taxi-in can run 10-15+ minutes at 1 Hz otherwise). Applies to both pre-departure and
// post-landing taxiing; the phase doesn't distinguish them.
const TAXI_TRACK_INTERVAL_S = 3
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

  constructor(private readonly flightId: number) {}

  /** "Freeze the phase machine on pause" (PLAN.md §7) — no transitions, no points, while true. */
  setPaused(paused: boolean): void {
    this.paused = paused
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

  private advancePhase(t: SimTelemetry): void {
    switch (this.phase) {
      case 'preflight':
        if (t.onGround && (t.groundSpeedMs > MOVING_MS || t.engineCombustion1)) {
          this.phase = 'pushback'
        }
        break

      case 'pushback':
        if (t.groundSpeedMs > TAXI_SPEED_MS) this.phase = 'taxi'
        break

      case 'taxi':
        // A genuine go-around/touch-and-go — the aircraft is actually airborne again, not
        // just a rollout groundspeed blip (that case never leaves the ground) — goes
        // straight back to 'climb', same as 'landing' below. Checked before the
        // hasLanded-guarded branch so a real second departure is never mistaken for the
        // rollout noise that guard exists to block.
        if (!t.onGround) {
          this.phase = 'climb'
          break
        }
        if (!this.hasLanded && t.groundSpeedMs > ROLL_SPEED_MS) this.phase = 'takeoff'
        break

      case 'takeoff':
        if (!t.onGround) this.phase = 'climb'
        break

      case 'climb':
        this.levelStreak = Math.abs(t.verticalSpeedMs) < LEVEL_VS_MS ? this.levelStreak + 1 : 0
        if (this.levelStreak >= LEVEL_SUSTAIN_SAMPLES) {
          this.phase = 'cruise'
          this.levelStreak = 0
        }
        break

      case 'cruise':
        this.descentStreak = t.verticalSpeedMs < DESCENT_VS_MS ? this.descentStreak + 1 : 0
        if (this.descentStreak >= DESCENT_SUSTAIN_SAMPLES) {
          this.phase = 'descent'
          this.descentStreak = 0
          this.levelStreak = 0
        }
        break

      case 'descent':
        // Matches M6's own touchdown detection: the on-ground false→true transition.
        if (t.onGround) {
          this.phase = 'landing'
          this.hasLanded = true
          break
        }
        // A routine flight-level step-down sustains a descent rate for well over
        // DESCENT_SUSTAIN_SAMPLES too, so without this a level-off afterwards would leave
        // the flight stuck recording as "descent" all the way to touchdown. Levelling off
        // again before the ground goes back to cruise instead.
        this.levelStreak = Math.abs(t.verticalSpeedMs) < LEVEL_VS_MS ? this.levelStreak + 1 : 0
        if (this.levelStreak >= LEVEL_SUSTAIN_SAMPLES) {
          this.phase = 'cruise'
          this.levelStreak = 0
        }
        break

      case 'landing':
        // Same go-around case as 'taxi' above — a rejected landing / touch-and-go that
        // never actually slowed through ROLL_SPEED_MS before going around again.
        if (!t.onGround) {
          this.phase = 'climb'
          break
        }
        if (t.groundSpeedMs < ROLL_SPEED_MS) this.phase = 'taxi'
        break

      case 'shutdown':
        break
    }

    // Reachable from the post-landing 'taxi' phase only — the same speed/brake/engine
    // state during the initial preflight phase instead drives the pushback transition
    // above, so there's no ambiguity between "not yet started" and "shut down".
    if (this.phase === 'taxi' && t.groundSpeedMs < MOVING_MS && t.parkingBrakeOn && !t.engineCombustion1) {
      this.phase = 'shutdown'
    }
  }

  private shouldRecord(t: SimTelemetry, nowUtc: Date): boolean {
    if (!this.lastPointAt) return true
    const elapsedS = (nowUtc.getTime() - this.lastPointAt.getTime()) / 1000
    let interval = 1
    if (this.phase === 'cruise') interval = CRUISE_TRACK_INTERVAL_S
    else if (this.phase === 'climb') interval = CLIMB_TRACK_INTERVAL_S
    else if (this.phase === 'taxi') interval = TAXI_TRACK_INTERVAL_S
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
      windDirectionDeg: t.windDirectionDeg
    }
  }
}
