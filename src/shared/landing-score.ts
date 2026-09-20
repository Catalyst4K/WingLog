// Landing score (0-100, floored for display) — flightdeck-backend's docs/plans/
// landing-scoring.md ("Final design", settled 2026-09-12), reworked by
// landing-scoring-v2.md (2026-09-20): tapered (quadratic) falloff replacing the original
// straight-line taper, plus a separate dangerous-exceedance deduction. Pure, no I/O:
// usable from both the main process (which
// resolves the runway/wake-category lookups this needs real vendored data for — see
// src/main/db/landing-score-resolver.ts) and the renderer (for tests/rendering only, never
// for its own I/O — the renderer still never touches the filesystem, per CLAUDE.md).
import type { LandingSeverity } from './ipc'

export type WakeCategory = 'L' | 'M' | 'H' | 'J'

/**
 * Real touchdown vertical-speed sweet spots per ICAO wake-turbulence category
 * (resources/icao-aircraft-types.csv's real `wtc` column) — informed judgement calls, not
 * sourced from a per-type manufacturer figure (same honest caveat this replaces carried —
 * see docs/decisions.md, 2026-09-12). `minFpm`/`maxFpm` are the category's real labelled
 * "ideal range" — kept here as the source table's own reference data, not fed directly into
 * computeLandingScore's own zero point: an early version made the score reach 0 right at
 * `minFpm`, which Callum flagged as too harsh (2026-09-13) — a touchdown just under the
 * labelled range is still a perfectly fine, gentle landing in the real world, not a failing
 * one. The score's actual tolerance (see computeLandingScore) is wider and symmetric around
 * `sweetSpotFpm` on both sides. J (only 2 rows of real vendored data — A380) shares H's
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
  /** This runway's own real paved length — touchdownZoneScore's real per-runway band count
   *  (touchdownZonePairCountForLengthM) comes from this, same source and reasoning as
   *  src/renderer/src/touchdown-diagram.ts's identical touchdown-zone marking geometry. Null
   *  exactly when distanceFromAimingPointM is (no runway match, or a match with no real
   *  length data — resolveLandingScore folds both cases into the same null). */
  runwayLengthM: number | null
  /** Signed lateral offset from the runway centreline (0 = dead centre). */
  centrelineOffsetM: number | null
  /** Where the centreline input's score hits 0 — half the runway's real width, or
   *  runway-lookup.ts's FALLBACK_LATERAL_TOLERANCE_M when width is unknown. Null exactly
   *  when centrelineOffsetM is null (no runway match at all). */
  centrelineToleranceM: number | null
}

/** What "perfect" and "score reaches 0" actually are for one category, in that category's
 *  own natural unit (fpm for verticalSpeed, degrees, g, or metres) — real per-flight numbers
 *  for the two runway-dependent categories (centrelineOffset's tolerance is this runway's
 *  own real half-width; distanceFromAimingPoint's is its own real touchdown-zone marking
 *  extent, touchdownZonePairCountForLengthM(runwayLengthM) pairs of TOUCHDOWN_ZONE_PAIR_
 *  SPACING_M each — 2026-09-13, replacing a flat aimingPointToleranceM-based tolerance),
 *  fixed constants for the rest. Symmetric for every category, including verticalSpeed
 *  (2026-09-13 — see LandingRateBand's own doc comment for why it isn't tighter on the soft
 *  side). */
export interface LandingScoreCategoryDetail {
  ideal: number
  /** Deviation from `ideal` (same unit) at which this category's score reaches 0. */
  tolerance: number
}

export interface LandingScoreBreakdown {
  /** The real computed score — can go negative once the dangerous-exceedance deduction
   *  applies (docs/decisions.md, 2026-09-20: "the overall score floors at 0 for display
   *  even though the math can go negative internally"). Flooring for display is the
   *  caller's job (src/main/db/landing-score-resolver.ts), not this function's — a
   *  negative value is real information (how far past dangerous this landing was), not
   *  a bug to hide here. */
  overall: number
  /** True when the touchdown vertical speed reached this category's own hard-landing
   *  threshold (`deriveLandingThresholds`'s `hardFpm`) — Callum's real example was an H
   *  category touchdown past 600fpm, which is exactly that category's own hardFpm, not a
   *  flat number across categories. Triggers DANGEROUS_EXCEEDANCE_DEDUCTION on `overall`. */
  dangerousExceedance: boolean
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
// over is a genuine, if minor, miss rather than nothing. 9 put 5° clearly under the bad
// threshold (score 44) under the original straight-line taper.
// Retightened to 6.5, 2026-09-20 (landing-scoring-v2.md): switching taperedScore's shape
// from linear to quadratic (see that function's own doc comment) is deliberately gentler
// near ideal, which pushed 5° back up to 69 — silently undoing the exact real-incident fix
// above. 6.5 restores the same intent under the new curve (5° -> 41, clearly under 50; 2°
// -> 91, still gentle) — a re-derived judgement call, not a re-sourced limit.
const CRAB_TOLERANCE_DEG = 6.5

// ICAO Annex 14 §5.2.6 touchdown-zone marking — pair count by landing distance available
// (Manual of Aerodrome Standards table, same secondary source runway-lookup.ts's own
// aimingPointDistanceForLengthM already cites): <900m→1, <1200m→2, <1500m→3, <2400m→4,
// ≥2400m→6 pairs (no "5 pairs" band). Spaced every 150m, the first pair centred 150m from
// the (usable, displacement-adjusted) threshold — src/renderer/src/touchdown-diagram.ts's
// TouchdownDiagram draws these same real positions; this is the one shared home for both so
// the score and the diagram can never quietly drift apart (moved here from that file,
// 2026-09-13, when the score started needing the same real geometry).
export const TOUCHDOWN_ZONE_PAIR_SPACING_M = 150

export function touchdownZonePairCountForLengthM(lengthM: number): number {
  if (lengthM < 900) return 1
  if (lengthM < 1200) return 2
  if (lengthM < 1500) return 3
  if (lengthM < 2400) return 4
  return 6
}

// Touchdown-zone (piano-key) scoring for how far along the runway the touchdown landed from
// the aiming point — a stepped scale rather than a smooth taper, matching how touchdown-zone
// markings actually read in real life (which pair of stripes did you land within, not a
// continuous distance), applied symmetrically either side of the aiming point per Callum's
// own spec, 2026-09-13: dead on the aiming point is perfect; the next real marking interval
// is 2 points down (out of 10); the one after that is 4 points down; past the last real
// marking pair for this runway's own length is a genuine miss, straight to 0 — not a further
// gentle taper, since going past the last real piano key means you're off the graded target
// area altogether, not just "a bit further from ideal." Band count comes from the runway's
// own real length (touchdownZonePairCountForLengthM above) rather than a fixed number, so a
// long runway's genuinely wider marked touchdown zone (up to 900m/6 pairs) gets a more
// forgiving graduated scale than a short one (as little as 150m/1 pair) — matching how much
// real margin for error each actually has, the same reasoning LANDING_RATE_BANDS above
// already applies to L's tighter fpm tolerance. -20 points (out of 100) per pair means a
// 6-pair runway's staircase (100/80/60/40/20/0) reaches exactly 0 at its own last real pair,
// with no separate cliff needed; shorter runways cliff straight to 0 right after whichever
// pair is their last.
function touchdownZoneScore(offsetM: number, pairCount: number): number {
  const bandIndex = Math.floor(Math.abs(offsetM) / TOUCHDOWN_ZONE_PAIR_SPACING_M)
  return bandIndex < pairCount ? Math.max(0, 100 - 20 * bandIndex) : 0
}

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

// Landing scoring v2 (flightdeck-backend's docs/plans/landing-scoring-v2.md, Callum's
// answered decisions, 2026-09-20): the falloff was a judgement call, no concrete real
// landing to calibrate the shape against — a tapered (quadratic-style) curve, gentle near
// ideal and steep near/past tolerance, replacing the old straight-line taper. Was called
// linearScore; renamed since it's no longer linear.
/** Quadratic falloff to 0 at `tolerance` past `ideal` (deviation already `actual - ideal`),
 *  clamped to [0,100] so a single input can never go negative on its own. Squaring the
 *  fraction of tolerance used means a small deviation barely moves the score (flat near
 *  ideal) while the same absolute step matters far more as it approaches tolerance (steep
 *  near/past it) — the opposite shape from a straight-line taper, which penalizes every
 *  increment equally regardless of how close to ideal it started. */
function taperedScore(deviation: number, tolerance: number): number {
  const magnitude = Math.abs(deviation)
  if (tolerance <= 0) return magnitude === 0 ? 100 : 0
  const fraction = magnitude / tolerance
  return Math.max(0, Math.min(100, Math.round(100 * (1 - fraction * fraction))))
}

// Judgement call, same honesty register as the rest of this file's constants — no real
// hard-landing data yet to calibrate the exact size against (docs/simconnect-notes.md,
// 2026-09-20's spike only captured normal landings). Applied once, flat, on top of the
// normal weighted average — not folded into verticalSpeed's own already-zeroed category
// score, so a dangerous touchdown reads as worse than "just the vertical-speed category
// bottomed out," which a hard landing with otherwise-good pitch/bank/centreline could
// otherwise mask.
const DANGEROUS_EXCEEDANCE_DEDUCTION = 20

/**
 * The 0-100 landing score (0-100 for display; see LandingScoreBreakdown's own doc comment
 * on `overall` for why the raw value here can be negative). Each of the 7 inputs is scored
 * and clamped to [0,100] independently before combining, so no single input can drag
 * `overall` negative on its own — only the separate dangerous-exceedance deduction can
 * (landing-scoring-v2.md, 2026-09-20, reopening docs/decisions.md's 2026-09-12 "no separate
 * dangerous floor step" — v1 deliberately had none; v2 added exactly one, on purpose).
 */
export function computeLandingScore(inputs: LandingScoreInputs): LandingScoreBreakdown {
  const thresholds = deriveLandingThresholds(inputs.category)
  const band = landingRateBand(inputs.category)
  const actualFpm = Math.abs(msToFpm(inputs.verticalSpeedMs))
  // Two-sided: peaks at the category's real sweet spot and decays symmetrically either side
  // of it (flightdeck-backend's docs/plans/landing-scoring.md, "fpm sweet spots", 2026-09-13)
  // rather than only penalizing an excessive descent rate. The tolerance is the same distance
  // out as the derived hard-landing threshold — a first cut instead reached 0 right at the
  // band's own minFpm on the soft side, which Callum found too harsh: a touchdown a little
  // under the labelled range is still a fine, gentle landing, not a failing one, and there's
  // no real safety case for punishing "too soft" anywhere near as hard as "too firm".
  const verticalSpeedTolerance = thresholds.hardFpm - band.sweetSpotFpm
  const verticalSpeed = taperedScore(actualFpm - band.sweetSpotFpm, verticalSpeedTolerance)
  const dangerousExceedance = actualFpm >= thresholds.hardFpm

  const gForce = taperedScore(inputs.gForce - GFORCE_IDEAL, GFORCE_TOLERANCE)
  const pitch = taperedScore(inputs.pitchDeg - PITCH_IDEAL_DEG, PITCH_TOLERANCE_DEG)
  const bank = taperedScore(inputs.bankDeg - BANK_IDEAL_DEG, BANK_TOLERANCE_DEG)
  const crab = inputs.crabDeg === null ? null : taperedScore(inputs.crabDeg - CRAB_IDEAL_DEG, CRAB_TOLERANCE_DEG)
  const touchdownZonePairCount =
    inputs.runwayLengthM === null ? null : touchdownZonePairCountForLengthM(inputs.runwayLengthM)
  const distanceFromAimingPoint =
    inputs.distanceFromAimingPointM === null || touchdownZonePairCount === null
      ? null
      : touchdownZoneScore(inputs.distanceFromAimingPointM, touchdownZonePairCount)
  const centrelineOffset =
    inputs.centrelineOffsetM === null || inputs.centrelineToleranceM === null
      ? null
      : taperedScore(inputs.centrelineOffsetM, inputs.centrelineToleranceM)

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
  const weightedOverall = availableWeight === 0 ? 0 : Math.round(weightedSum / availableWeight)
  const overall = dangerousExceedance ? weightedOverall - DANGEROUS_EXCEEDANCE_DEDUCTION : weightedOverall

  return {
    overall,
    dangerousExceedance,
    inputs: { verticalSpeed, gForce, distanceFromAimingPoint, centrelineOffset, pitch, bank, crab },
    details: {
      verticalSpeed: { ideal: band.sweetSpotFpm, tolerance: verticalSpeedTolerance },
      gForce: { ideal: GFORCE_IDEAL, tolerance: GFORCE_TOLERANCE },
      pitch: { ideal: PITCH_IDEAL_DEG, tolerance: PITCH_TOLERANCE_DEG },
      bank: { ideal: BANK_IDEAL_DEG, tolerance: BANK_TOLERANCE_DEG },
      crab: inputs.crabDeg === null ? null : { ideal: CRAB_IDEAL_DEG, tolerance: CRAB_TOLERANCE_DEG },
      distanceFromAimingPoint:
        touchdownZonePairCount === null
          ? null
          : { ideal: 0, tolerance: touchdownZonePairCount * TOUCHDOWN_ZONE_PAIR_SPACING_M },
      centrelineOffset:
        inputs.centrelineToleranceM === null ? null : { ideal: 0, tolerance: inputs.centrelineToleranceM }
    }
  }
}
