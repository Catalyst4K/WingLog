/**
 * The flight phase machine as a pure step function (coding-standards.md §10): `(state, telemetry, nowMs, settings) → state`.
 * `FlightRecorder` is the thin wrapper that holds the state and settings and builds the track point; the offline simulation and
 * the replay tests feed real captured flights through this same code. The clock comes in as input.
 */
import type { FlightPhase, NewTrackPoint, SimTelemetry } from '@shared/ipc'

// Thresholds are first-pass estimates (PLAN.md doesn't prescribe exact values), to refine by watching real flights track through
// every phase; see docs/simconnect-notes.md for anything surprising. Exported: free-flight.ts's seedPhaseFromTelemetry reuses these
// two thresholds to seed a mid-session-started flight into the phase it would already be in, rather than inventing separate
// seeding-only numbers.
export const MOVING_MS = 0.5 // ~1 kt — any ground movement at all, used for pushback detection
const TAXI_SPEED_MS = 2.6 // ~5 kt — established taxi under own power vs. still being pushed
const ROLL_SPEED_MS = 18 // ~35 kt — takeoff-roll / landing-rollout boundary vs. taxi speed
export const LEVEL_VS_MS = 0.5 // ~100 fpm — vertical speed magnitude counted as "level"
const DESCENT_VS_MS = -1.0 // ~-200 fpm — sustained descent rate that ends cruise
const LEVEL_SUSTAIN_SAMPLES = 10 // consecutive 1 Hz samples of level flight to confirm cruise
const DESCENT_SUSTAIN_SAMPLES = 5 // consecutive samples of descent to confirm leaving cruise
// Consecutive airborne samples before a rollout or taxi counts as a go-around (and, the other way round, ground samples before
// 'climb'/'cruise' counts as a missed landing). One wasn't enough: a single airborne tick on a bouncy rollout sent the phase
// 'landing' -> 'climb' -> 'cruise' and recorded the whole taxi-in as cruise. Same count as TrackingController's
// MIN_AIRBORNE_SAMPLES_FOR_NEW_TOUCHDOWN, which already kept that bounce from being logged as a second landing.
const GO_AROUND_AIRBORNE_SAMPLES = 3
// docs/decisions.md, 2026-09-01: deviates from PLAN.md §5's "every 15s" — 5s reads better
// live without needing to keep the old marker/camera interpolation to hide the jump.
const CRUISE_TRACK_INTERVAL_S = 5
const CLIMB_TRACK_INTERVAL_S = 2 // slightly coarser than the 1s default elsewhere
// Taxi records at the same 1s as every other ground phase (no entry in shouldRecord). It was
// 3s until 2026-10: points then sat 20-60m apart, so every turn drew as a chord straight
// across the taxiway fillet. The map's own ground simplification (track-simplify.ts) keeps
// only the turns for display anyway, so the extra rows only cost storage.
// Descent from cruise altitude down to pattern altitude can be 20-40+ minutes at 1 Hz — the single biggest remaining point-count/CPU
// cost outside cruise itself, and unlike climb/cruise none of it needs to be dense: buildLandingRecord (landing-capture.ts)
// captures its metrics from the live telemetry tick at the descent->landing transition, not from track_point rows, so this has no
// effect on landing-analysis accuracy. Only applied above DESCENT_APPROACH_AGL_M, comfortably above where a stabilized approach
// begins, so the last stretch down to touchdown still records at full resolution.
const DESCENT_HIGH_ALTITUDE_INTERVAL_S = 5
const DESCENT_APPROACH_AGL_M = 500 // ~1,640 ft AGL

/** Everything the phase machine remembers between ticks. */
export interface PhaseState {
  phase: FlightPhase
  levelStreak: number
  descentStreak: number
  airborneStreak: number
  groundStreak: number
  /** When the last track point was recorded, epoch ms; null before the first. */
  lastPointAtMs: number | null
  // Set once, at touchdown, and never cleared: guards the taxi -> takeoff transition so a rollout or taxi-in speed blip (e.g.
  // reverse thrust pushing ground speed back over ROLL_SPEED_MS) isn't mistaken for a second takeoff roll. Without it the machine
  // got stuck in 'takeoff' after landing, which only exits via !onGround, so the flight never reached 'shutdown' and
  // auto-completion never fired.
  hasLanded: boolean
  // Tags every point this recorder writes: 0 for a flight never resumed, incremented by TrackingController.resume() each time the
  // app restarts mid-flight, or when a resume-cleanup pass finds a physically-impossible jump with no resume() involved
  // (winglog-backend's docs/plans/done/resume-track-cleanup.md: a payware aircraft's own save-state/reload). The phase machine never
  // touches it; the map uses it to avoid drawing a line across a spawn-point/teleport-back artefact, even before any cleanup
  // decides which points in a segment are spurious.
  resumeSegment: number
}

/** What the caller can switch, none of it changed by a tick. */
export interface PhaseSettings {
  /** "Freeze the phase machine on pause" (PLAN.md §7): no transitions and no points while true. */
  paused: boolean
  /** Settings → Tracking → "Finish flights automatically". Off, the machine never enters 'shutdown' on its own. */
  autoShutdown: boolean
  /** Whether a point is on a runway, or null when that can't be known. Only asked when ground speed passes ROLL_SPEED_MS while taxiing. */
  runwayCheck: (lat: number, lon: number) => boolean | null
}

/** A flight at the gate, before anything has happened. */
export const INITIAL_PHASE_STATE: PhaseState = {
  phase: 'preflight',
  levelStreak: 0,
  descentStreak: 0,
  airborneStreak: 0,
  groundStreak: 0,
  lastPointAtMs: null,
  hasLanded: false,
  resumeSegment: 0
}

/** What one tick produced. */
export interface PhaseStep {
  state: PhaseState
  /** Whether this tick becomes a persisted track point (its time is already in `state.lastPointAtMs`). */
  record: boolean
}

/**
 * One tick of the phase machine: the current phase's own transition, then auto-shutdown, then whether the tick is recorded.
 *
 * @param state The state now.
 * @param t This tick's telemetry.
 * @param nowMs When it was received, epoch ms.
 * @param settings Paused, auto-shutdown and the runway check.
 * @returns The state after, and whether to record a point.
 */
export function stepPhase(state: PhaseState, t: SimTelemetry, nowMs: number, settings: PhaseSettings): PhaseStep {
  // "Ignore samples while IS SLEW ACTIVE" (PLAN.md §7): slewing teleports the aircraft, which would otherwise read as a
  // physically impossible speed/phase jump.
  if (settings.paused || t.slewActive) return { state, record: false }
  const s: PhaseState = { ...state } // a draft, changed in place below
  advancePhase(s, t, settings)
  if (!shouldRecord(s, t, nowMs)) return { state: s, record: false }
  s.lastPointAtMs = nowMs
  return { state: s, record: true }
}

/**
 * Builds the track point to store from one telemetry sample.
 *
 * @param flightId The flight.
 * @param state The state after the tick (its phase and resume segment are stamped on the point).
 * @param t The telemetry.
 * @param nowUtc When it was received.
 * @returns The track point for this flight.
 */
export function buildTrackPoint(flightId: number, state: PhaseState, t: SimTelemetry, nowUtc: Date): NewTrackPoint {
  return {
    flightId,
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
    phase: state.phase,
    onGround: t.onGround,
    fuelKg: t.fuelTotalKg,
    gForce: t.gForce,
    windSpeedMs: t.windSpeedMs,
    windDirectionDeg: t.windDirectionDeg,
    resumeSegment: state.resumeSegment,
    simRate: t.simRate,
    excludedReason: null
  }
}

/**
 * The current phase's own transition, then auto-shutdown.
 *
 * @param s The draft state.
 * @param t This tick.
 * @param settings The runway check and auto-shutdown switch.
 */
function advancePhase(s: PhaseState, t: SimTelemetry, settings: PhaseSettings): void {
  switch (s.phase) {
    case 'preflight':
      if (t.onGround && (t.groundSpeedMs > MOVING_MS || t.engineCombustion1)) s.phase = 'pushback'
      break
    case 'pushback':
      if (t.groundSpeedMs > TAXI_SPEED_MS) s.phase = 'taxi'
      break
    case 'taxi':
      fromTaxi(s, t, settings)
      break
    case 'takeoff':
      fromTakeoff(s, t)
      break
    case 'climb':
      fromClimb(s, t)
      break
    case 'cruise':
      fromCruise(s, t)
      break
    case 'descent':
      fromDescent(s, t)
      break
    case 'landing':
      fromLanding(s, t)
      break
    case 'shutdown':
      break
  }
  shutDownIfParked(s, t, settings)
}

/**
 * From 'taxi': a go-around, or the takeoff roll.
 *
 * @param s The draft state.
 * @param t This tick.
 * @param settings The runway check.
 */
function fromTaxi(s: PhaseState, t: SimTelemetry, settings: PhaseSettings): void {
  // A genuine go-around/touch-and-go — the aircraft is actually airborne again, not just a rollout groundspeed blip (that case never
  // leaves the ground) — goes straight back to 'climb', same as 'landing'. Checked before the hasLanded-guarded branch so a real
  // second departure is never mistaken for the rollout noise that guard exists to block.
  if (goneAround(s, t)) return
  // Only on a runway, when that's known: a fast taxi along a parallel taxiway isn't the takeoff roll.
  if (!s.hasLanded && t.groundSpeedMs > ROLL_SPEED_MS && settings.runwayCheck(t.latitude, t.longitude) !== false) {
    s.phase = 'takeoff'
  }
}

/**
 * From 'landing': slowed to taxi speed, or a go-around (a rejected landing or touch-and-go that never slowed through
 * ROLL_SPEED_MS), as from 'taxi'.
 *
 * @param s The draft state.
 * @param t This tick.
 */
function fromLanding(s: PhaseState, t: SimTelemetry): void {
  if (!goneAround(s, t) && t.groundSpeedMs < ROLL_SPEED_MS) s.phase = 'taxi'
}

/**
 * From 'takeoff': airborne, or a rejected takeoff back to 'taxi'.
 *
 * @param s The draft state.
 * @param t This tick.
 */
function fromTakeoff(s: PhaseState, t: SimTelemetry): void {
  // A rejected takeoff — aborted before ever leaving the ground — has no way back to 'taxi' without the speed check: the only other
  // exit is !t.onGround, which never happens if the aircraft decelerates and taxis back instead of departing. Mirrors 'landing'.
  if (!t.onGround) {
    s.phase = 'climb'
    return
  }
  if (t.groundSpeedMs < ROLL_SPEED_MS) s.phase = 'taxi'
}

/**
 * From 'climb': level for long enough is cruise.
 *
 * @param s The draft state.
 * @param t This tick.
 */
function fromClimb(s: PhaseState, t: SimTelemetry): void {
  if (backOnGround(s, t)) return
  s.levelStreak = Math.abs(t.verticalSpeedMs) < LEVEL_VS_MS ? s.levelStreak + 1 : 0
  if (s.levelStreak >= LEVEL_SUSTAIN_SAMPLES) {
    s.phase = 'cruise'
    s.levelStreak = 0
  }
}

/**
 * From 'cruise': descending for long enough is descent.
 *
 * @param s The draft state.
 * @param t This tick.
 */
function fromCruise(s: PhaseState, t: SimTelemetry): void {
  if (backOnGround(s, t)) return
  s.descentStreak = t.verticalSpeedMs < DESCENT_VS_MS ? s.descentStreak + 1 : 0
  if (s.descentStreak >= DESCENT_SUSTAIN_SAMPLES) {
    s.phase = 'descent'
    s.descentStreak = 0
    s.levelStreak = 0
  }
}

/**
 * From 'descent': touchdown is landing; levelling off again is back to cruise.
 *
 * @param s The draft state.
 * @param t This tick.
 */
function fromDescent(s: PhaseState, t: SimTelemetry): void {
  // Matches the touchdown detection: the on-ground false→true transition.
  if (t.onGround) {
    s.phase = 'landing'
    s.hasLanded = true
    return
  }
  // A routine flight-level step-down sustains a descent rate for well over DESCENT_SUSTAIN_SAMPLES too, so without this a level-off
  // afterwards would leave the flight stuck recording as "descent" all the way to touchdown.
  s.levelStreak = Math.abs(t.verticalSpeedMs) < LEVEL_VS_MS ? s.levelStreak + 1 : 0
  if (s.levelStreak >= LEVEL_SUSTAIN_SAMPLES) {
    s.phase = 'cruise'
    s.levelStreak = 0
  }
}

/**
 * Taxiing after landing, stopped with the parking brake set and the engines off: shutdown. Only from the post-landing 'taxi'
 * phase: the same state in 'preflight' drives pushback instead, so "not yet started" and "shut down" can't be confused.
 *
 * @param s The draft state.
 * @param t This tick.
 * @param settings The auto-shutdown switch.
 */
function shutDownIfParked(s: PhaseState, t: SimTelemetry, settings: PhaseSettings): void {
  if (settings.autoShutdown && s.phase === 'taxi' && t.groundSpeedMs < MOVING_MS && t.parkingBrakeOn && !t.engineCombustion1) {
    s.phase = 'shutdown'
  }
}

/**
 * 'landing'/'taxi' -> 'climb' only once airborne for GO_AROUND_AIRBORNE_SAMPLES in a row; true while airborne at all, so the
 * caller skips its on-the-ground checks.
 *
 * @param s The draft state.
 * @param t This tick.
 * @returns Whether the aircraft is airborne.
 */
function goneAround(s: PhaseState, t: SimTelemetry): boolean {
  if (t.onGround) {
    s.airborneStreak = 0
    return false
  }
  s.airborneStreak += 1
  if (s.airborneStreak >= GO_AROUND_AIRBORNE_SAMPLES) {
    s.phase = 'climb'
    s.airborneStreak = 0
    s.levelStreak = 0
  }
  return true
}

/**
 * On the ground in 'climb'/'cruise' for GO_AROUND_AIRBORNE_SAMPLES in a row: a landing the machine missed. A bounce that outlasted
 * the go-around check, a flight resumed in that state, or a circuit that touched down straight from 'climb' without reaching
 * 'descent'. Back to 'landing', which reaches 'taxi' on speed as usual; one tick back on the runway just after liftoff is left alone.
 *
 * @param s The draft state.
 * @param t This tick.
 * @returns Whether the phase went back to 'landing'.
 */
function backOnGround(s: PhaseState, t: SimTelemetry): boolean {
  if (!t.onGround) {
    s.groundStreak = 0
    return false
  }
  s.groundStreak += 1
  if (s.groundStreak < GO_AROUND_AIRBORNE_SAMPLES) return false
  s.phase = 'landing'
  s.hasLanded = true
  s.groundStreak = 0
  s.levelStreak = 0
  s.descentStreak = 0
  return true
}

/**
 * Whether this tick becomes a track point: the first always, then one per phase-dependent interval.
 *
 * @param s The state after the tick.
 * @param t This tick.
 * @param nowMs When it was received, epoch ms.
 * @returns True when enough time has passed since the last point.
 */
function shouldRecord(s: PhaseState, t: SimTelemetry, nowMs: number): boolean {
  if (s.lastPointAtMs === null) return true
  const elapsedS = (nowMs - s.lastPointAtMs) / 1000
  let interval = 1
  if (s.phase === 'cruise') interval = CRUISE_TRACK_INTERVAL_S
  else if (s.phase === 'climb') interval = CLIMB_TRACK_INTERVAL_S
  else if (s.phase === 'descent' && t.altitudeAglM > DESCENT_APPROACH_AGL_M) {
    interval = DESCENT_HIGH_ALTITUDE_INTERVAL_S
  }
  return elapsedS >= interval
}
