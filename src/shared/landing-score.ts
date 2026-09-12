// Landing score (0-100) — flightdeck-backend's docs/plans/landing-scoring.md ("Final
// design", settled 2026-09-12). Pure, no I/O: usable from both the main process (which
// resolves the runway/wake-category lookups this needs real vendored data for — see
// src/main/db/landing-score-resolver.ts) and the renderer (for tests/rendering only, never
// for its own I/O — the renderer still never touches the filesystem, per CLAUDE.md).
import type { LandingSeverity } from './ipc'

export type WakeCategory = 'L' | 'M' | 'H' | 'J'

/**
 * Ideal ("expected") touchdown vertical speed per ICAO wake-turbulence category
 * (resources/icao-aircraft-types.csv's real `wtc` column) — informed judgement calls, not
 * sourced from a per-type manufacturer figure (same honest caveat this replaces carried —
 * see docs/decisions.md, 2026-09-12). J (only 2 rows of real vendored data — A380) shares
 * H's value rather than inventing its own.
 */
export const IDEAL_VERTICAL_SPEED_FPM: Record<WakeCategory, number> = {
  L: 150,
  M: 130,
  H: 110,
  J: 110
}

// Applied to an unrecognised/ambiguous type (not in the vendored CSV, or a genuinely
// mixed "L/M" wtc value) — matches this app's previous single non-type-specific default's
// leaning (narrowbody-ish), rather than silently applying an extreme L or H number to a
// type this app doesn't actually know the category of.
const UNKNOWN_CATEGORY_FALLBACK: WakeCategory = 'M'

export function idealVerticalSpeedFpm(category: WakeCategory | null): number {
  return IDEAL_VERTICAL_SPEED_FPM[category ?? UNKNOWN_CATEGORY_FALLBACK]
}

export interface LandingThresholds {
  firmFpm: number
  hardFpm: number
}

// Derives firm/hard from the category's own ideal rather than a user-editable Settings
// value (docs/decisions.md, 2026-09-12 — Callum's explicit instruction to remove the old
// Settings control entirely). Multipliers are a first-pass judgement call, same honesty
// register as IDEAL_VERTICAL_SPEED_FPM above.
const FIRM_MULTIPLIER = 2.5
const HARD_MULTIPLIER = 4.0

export function deriveLandingThresholds(category: WakeCategory | null): LandingThresholds {
  const ideal = idealVerticalSpeedFpm(category)
  return { firmFpm: ideal * FIRM_MULTIPLIER, hardFpm: ideal * HARD_MULTIPLIER }
}

// Same conversion as src/renderer/src/units.ts's msToFpm, duplicated rather than imported
// — that file is renderer-only (depends on @shared/ipc's unit-preference types for its
// other exports) and this module needs to stay importable from the main process too.
const M_PER_FT = 0.3048
function msToFpm(ms: number): number {
  return (ms / M_PER_FT) * 60
}

/**
 * Classifies a touchdown against derived thresholds. Vertical speed is negative
 * (descending) — classified on magnitude, since a "harder" landing is a larger descent
 * rate regardless of sign convention. Moved verbatim from the old
 * src/renderer/src/landing-severity.ts (same signature/behaviour) — only where its
 * `thresholds` argument comes from has changed.
 */
export function classifyLanding(touchdownVerticalSpeedMs: number, thresholds: LandingThresholds): LandingSeverity {
  const fpm = Math.abs(msToFpm(touchdownVerticalSpeedMs))
  if (fpm >= thresholds.hardFpm) return 'hard'
  if (fpm >= thresholds.firmFpm) return 'firm'
  return 'none'
}

/**
 * Inputs the score is computed from. Runway-dependent fields (the aiming-point and
 * centreline pairs, and crab) are null together when a landing has no matched runway end
 * (landing-capture.ts's own null-handling convention for headwindMs/crosswindMs) — the
 * formula drops their weight and renormalizes rather than treating a missing input as a
 * bad one.
 */
export interface LandingScoreInputs {
  category: WakeCategory | null
  verticalSpeedMs: number
  gForce: number
  pitchDeg: number
  bankDeg: number
  crabDeg: number | null
  /** Signed deviation from the runway's real aiming point (0 = touchdown exactly on it). */
  distanceFromAimingPointM: number | null
  /** Where the aiming-point input's score hits 0 — the runway's own real Annex-14
   *  aiming-point distance from the threshold (runway-lookup.ts's aimingPointDistanceM).
   *  Null exactly when distanceFromAimingPointM is null. */
  aimingPointToleranceM: number | null
  /** Signed lateral offset from the runway centreline (0 = dead centre). */
  centrelineOffsetM: number | null
  /** Where the centreline input's score hits 0 — half the runway's real width, or
   *  runway-lookup.ts's FALLBACK_LATERAL_TOLERANCE_M when width is unknown. Null exactly
   *  when centrelineOffsetM is null (no runway match at all). */
  centrelineToleranceM: number | null
}

export interface LandingScoreBreakdown {
  overall: number
  inputs: {
    verticalSpeed: number
    gForce: number
    distanceFromAimingPoint: number | null
    centrelineOffset: number | null
    pitch: number
    bank: number
    crab: number | null
  }
}

const GFORCE_IDEAL = 1.0
const GFORCE_TOLERANCE = 1.0
// MSFS's PLANE PITCH DEGREES (simvars.ts) is negative for nose-up, positive for nose-down
// — confirmed two ways: flightdeck-backend's docs/simconnect-notes.md (2026-09-03) logged
// -6.709° at a real touchdown, and a real WingLog user reported (2026-09-12) a consistent
// flare across multiple of his own logged landings scoring as a pitch warning, which only
// makes sense if the sign here was backwards. A "4° nose-up" ideal flare is therefore -4 in
// this SimVar's own convention, not +4.
const PITCH_IDEAL_DEG = -4
const PITCH_TOLERANCE_DEG = 8
const BANK_IDEAL_DEG = 0
const BANK_TOLERANCE_DEG = 8
const CRAB_IDEAL_DEG = 0
// Was 15 at first ship. Tightened 2026-09-12 (docs/decisions.md) after a real-use report:
// Callum flagged that a 5.7° crab on a real landing wasn't showing as a bad category, and
// argued anything past ~5° residual crab at touchdown is worth a warning — most technique
// guidance has a pilot removing crab by touchdown (wing-low/de-crab), so a few degrees left
// over is a genuine, if minor, miss rather than nothing. 9 puts 5° clearly under the bad
// threshold (score 44) while still scoring 2-3° gently (78/67) and treating anything past
// 9° as a complete miss — a judgement call, not a sourced limit, same register as the other
// constants here.
const CRAB_TOLERANCE_DEG = 9

// Weights sum to 100 when every input is available (see computeLandingScore's
// renormalization when some aren't). First-pass judgement calls, same honesty register as
// the constants above — easy to retune later since the score is computed at read time, not
// stored, so a change re-scores every historical landing automatically.
export const WEIGHTS = {
  verticalSpeed: 25,
  gForce: 15,
  distanceFromAimingPoint: 20,
  centrelineOffset: 10,
  pitch: 10,
  bank: 10,
  crab: 10
} as const

/** Linear falloff to 0 at `tolerance` past `ideal` (deviation already `actual - ideal`),
 *  clamped to [0,100] so a single input can never go negative on its own. */
function linearScore(deviation: number, tolerance: number): number {
  const magnitude = Math.abs(deviation)
  if (tolerance <= 0) return magnitude === 0 ? 100 : 0
  return Math.max(0, Math.min(100, Math.round(100 * (1 - magnitude / tolerance))))
}

/**
 * The 0-100 landing score. Each of the 7 inputs is scored and clamped independently
 * before combining, so the combined score can't go negative on its own — there's no
 * separate "dangerous" floor step (docs/decisions.md, 2026-09-12).
 */
export function computeLandingScore(inputs: LandingScoreInputs): LandingScoreBreakdown {
  const thresholds = deriveLandingThresholds(inputs.category)
  const idealFpm = idealVerticalSpeedFpm(inputs.category)
  const actualFpm = Math.abs(msToFpm(inputs.verticalSpeedMs))
  // One-sided: only penalize exceeding the ideal descent rate, not being gentler than it.
  const verticalSpeedExcess = Math.max(0, actualFpm - idealFpm)
  const verticalSpeed = linearScore(verticalSpeedExcess, thresholds.hardFpm - idealFpm)

  const gForce = linearScore(inputs.gForce - GFORCE_IDEAL, GFORCE_TOLERANCE)
  const pitch = linearScore(inputs.pitchDeg - PITCH_IDEAL_DEG, PITCH_TOLERANCE_DEG)
  const bank = linearScore(inputs.bankDeg - BANK_IDEAL_DEG, BANK_TOLERANCE_DEG)
  const crab = inputs.crabDeg === null ? null : linearScore(inputs.crabDeg - CRAB_IDEAL_DEG, CRAB_TOLERANCE_DEG)
  const distanceFromAimingPoint =
    inputs.distanceFromAimingPointM === null || inputs.aimingPointToleranceM === null
      ? null
      : linearScore(inputs.distanceFromAimingPointM, inputs.aimingPointToleranceM)
  const centrelineOffset =
    inputs.centrelineOffsetM === null || inputs.centrelineToleranceM === null
      ? null
      : linearScore(inputs.centrelineOffsetM, inputs.centrelineToleranceM)

  const scored: { weight: number; score: number | null }[] = [
    { weight: WEIGHTS.verticalSpeed, score: verticalSpeed },
    { weight: WEIGHTS.gForce, score: gForce },
    { weight: WEIGHTS.distanceFromAimingPoint, score: distanceFromAimingPoint },
    { weight: WEIGHTS.centrelineOffset, score: centrelineOffset },
    { weight: WEIGHTS.pitch, score: pitch },
    { weight: WEIGHTS.bank, score: bank },
    { weight: WEIGHTS.crab, score: crab }
  ]

  let weightedSum = 0
  let availableWeight = 0
  for (const { weight, score } of scored) {
    if (score === null) continue
    weightedSum += weight * score
    availableWeight += weight
  }
  const overall = availableWeight === 0 ? 0 : Math.round(weightedSum / availableWeight)

  return {
    overall,
    inputs: { verticalSpeed, gForce, distanceFromAimingPoint, centrelineOffset, pitch, bank, crab }
  }
}
