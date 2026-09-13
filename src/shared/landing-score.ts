// Landing score (0-100) — flightdeck-backend's docs/plans/landing-scoring.md ("Final
// design", settled 2026-09-12). Pure, no I/O: usable from both the main process (which
// resolves the runway/wake-category lookups this needs real vendored data for — see
// src/main/db/landing-score-resolver.ts) and the renderer (for tests/rendering only, never
// for its own I/O — the renderer still never touches the filesystem, per CLAUDE.md).
import type { LandingSeverity } from './ipc'

export type WakeCategory = 'L' | 'M' | 'H' | 'J'

/**
 * Real touchdown vertical-speed sweet spots per ICAO wake-turbulence category
 * (resources/icao-aircraft-types.csv's real `wtc` column) — informed judgement calls, not
 * sourced from a per-type manufacturer figure (same honest caveat this replaces carried —
 * see docs/decisions.md, 2026-09-12). `minFpm`/`maxFpm` bound the range within which a
 * touchdown reads as genuinely "ideal" for that category — score peaks at `sweetSpotFpm`
 * and decays toward either edge (computeLandingScore below), rather than the range acting
 * as a single hard in/out cutoff. J (only 2 rows of real vendored data — A380) shares H's
 * range (similar gear stroke/inertia) but its sweet spot is nudged 10fpm higher — the
 * A380's longer-travel gear takes a bit more sink rate to feel "right" on touchdown.
 */
export interface LandingRateBand {
  minFpm: number
  sweetSpotFpm: number
  maxFpm: number
}

export const LANDING_RATE_BANDS: Record<WakeCategory, LandingRateBand> = {
  // Lower ceiling than the rest — light aircraft bounce/float more easily, so the same
  // absolute deviation off the sweet spot matters more here than for a heavier category.
  L: { minFpm: 60, sweetSpotFpm: 90, maxFpm: 140 },
  M: { minFpm: 80, sweetSpotFpm: 120, maxFpm: 160 },
  H: { minFpm: 100, sweetSpotFpm: 150, maxFpm: 200 },
  J: { minFpm: 100, sweetSpotFpm: 160, maxFpm: 200 }
}

// Applied to an unrecognised/ambiguous type (not in the vendored CSV, or a genuinely
// mixed "L/M" wtc value) — matches this app's previous single non-type-specific default's
// leaning (narrowbody-ish), rather than silently applying an extreme L or H number to a
// type this app doesn't actually know the category of.
const UNKNOWN_CATEGORY_FALLBACK: WakeCategory = 'M'

export function landingRateBand(category: WakeCategory | null): LandingRateBand {
  return LANDING_RATE_BANDS[category ?? UNKNOWN_CATEGORY_FALLBACK]
}

export interface LandingThresholds {
  firmFpm: number
  hardFpm: number
}

// Derives firm/hard from the category's own ideal rather than a user-editable Settings
// value (docs/decisions.md, 2026-09-12 — Callum's explicit instruction to remove the old
// Settings control entirely). Multipliers are a first-pass judgement call, same honesty
// register as LANDING_RATE_BANDS above.
const FIRM_MULTIPLIER = 2.5
const HARD_MULTIPLIER = 4.0

export function deriveLandingThresholds(category: WakeCategory | null): LandingThresholds {
  const ideal = landingRateBand(category).sweetSpotFpm
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

/** What "perfect" and "score reaches 0" actually are for one category, in that category's
 *  own natural unit (fpm for verticalSpeed, degrees, g, or metres) — real per-flight numbers
 *  for the two runway-dependent categories (their tolerance is this runway's own real
 *  Annex-14 aiming-point distance / half its real width), fixed constants for the rest. Split
 *  below/above `ideal` because verticalSpeed's real-world sweet spot isn't symmetric (a
 *  category's touchdown-rate band is tighter below the sweet spot than above it, per
 *  LANDING_RATE_BANDS) — every other category just has the two fields equal. */
export interface LandingScoreCategoryDetail {
  ideal: number
  /** Deviation below `ideal` (same unit) at which this category's score reaches 0. */
  toleranceBelow: number
  /** Deviation above `ideal` (same unit) at which this category's score reaches 0. */
  toleranceAbove: number
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
  /** Mirrors `inputs`' keys — null exactly when the matching input is null (no runway
   *  match), except `crab`: its ideal/tolerance are fixed constants independent of runway
   *  data, so they're only null when there's truly nothing to show (kept parallel to
   *  `crabDeg` rather than to the runway-dependent pair for that reason). */
  details: {
    verticalSpeed: LandingScoreCategoryDetail
    gForce: LandingScoreCategoryDetail
    distanceFromAimingPoint: LandingScoreCategoryDetail | null
    centrelineOffset: LandingScoreCategoryDetail | null
    pitch: LandingScoreCategoryDetail
    bank: LandingScoreCategoryDetail
    crab: LandingScoreCategoryDetail | null
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
const WEIGHTS = {
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

/** `linearScore`, but the tolerance can differ depending on which side of `ideal` the
 *  deviation falls on — verticalSpeed is the only category that actually needs this. */
function twoSidedScore(deviation: number, toleranceBelow: number, toleranceAbove: number): number {
  return linearScore(deviation, deviation < 0 ? toleranceBelow : toleranceAbove)
}

/** Every non-verticalSpeed category's tolerance is symmetric — same value on both sides. */
function symmetricDetail(ideal: number, tolerance: number): LandingScoreCategoryDetail {
  return { ideal, toleranceBelow: tolerance, toleranceAbove: tolerance }
}

/**
 * The 0-100 landing score. Each of the 7 inputs is scored and clamped independently
 * before combining, so the combined score can't go negative on its own — there's no
 * separate "dangerous" floor step (docs/decisions.md, 2026-09-12).
 */
export function computeLandingScore(inputs: LandingScoreInputs): LandingScoreBreakdown {
  const thresholds = deriveLandingThresholds(inputs.category)
  const band = landingRateBand(inputs.category)
  const actualFpm = Math.abs(msToFpm(inputs.verticalSpeedMs))
  // Two-sided: peaks at the category's real sweet spot and decays toward both edges of its
  // ideal range (flightdeck-backend's docs/plans/landing-scoring.md, "fpm sweet spots",
  // 2026-09-13) rather than only penalizing an excessive descent rate. Below the sweet spot,
  // score reaches 0 right at the range's own minFpm — a touchdown gentler than that reads as
  // genuinely too soft for the category (float/balloon risk, worse the lighter the aircraft),
  // not just "better than ideal". Above the sweet spot, score keeps the old wider tail out to
  // the derived hard-landing threshold, since that side is the one with real structural risk.
  const verticalSpeedDeviation = actualFpm - band.sweetSpotFpm
  const verticalSpeedToleranceBelow = band.sweetSpotFpm - band.minFpm
  const verticalSpeedToleranceAbove = thresholds.hardFpm - band.sweetSpotFpm
  const verticalSpeed = twoSidedScore(verticalSpeedDeviation, verticalSpeedToleranceBelow, verticalSpeedToleranceAbove)

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
    inputs: { verticalSpeed, gForce, distanceFromAimingPoint, centrelineOffset, pitch, bank, crab },
    details: {
      verticalSpeed: {
        ideal: band.sweetSpotFpm,
        toleranceBelow: verticalSpeedToleranceBelow,
        toleranceAbove: verticalSpeedToleranceAbove
      },
      gForce: symmetricDetail(GFORCE_IDEAL, GFORCE_TOLERANCE),
      pitch: symmetricDetail(PITCH_IDEAL_DEG, PITCH_TOLERANCE_DEG),
      bank: symmetricDetail(BANK_IDEAL_DEG, BANK_TOLERANCE_DEG),
      crab: inputs.crabDeg === null ? null : symmetricDetail(CRAB_IDEAL_DEG, CRAB_TOLERANCE_DEG),
      distanceFromAimingPoint:
        inputs.aimingPointToleranceM === null ? null : symmetricDetail(0, inputs.aimingPointToleranceM),
      centrelineOffset:
        inputs.centrelineToleranceM === null ? null : symmetricDetail(0, inputs.centrelineToleranceM)
    }
  }
}
