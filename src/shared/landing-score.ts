// Landing score (0-100, floored for display) — flightdeck-backend's docs/plans/
// landing-scoring.md ("Final design", settled 2026-09-12), reworked by
// landing-scoring-v2.md (2026-09-20): tapered falloff (fraction^1.5 — see taperedScore's
// own history for why not a full square) replacing the original straight-line taper, plus a
// separate dangerous-exceedance deduction. Pure, no I/O:
// usable from both the main process (which
// resolves the runway/wake-category lookups this needs real vendored data for — see
// src/main/db/landing-score-resolver.ts) and the renderer (for tests/rendering only, never
// for its own I/O — the renderer still never touches the filesystem, per CLAUDE.md).
import type { LandingScoreCategoryKey, LandingSeverity } from './ipc'

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
  /** This runway's own real paved length — distanceFromAimingPoint's real per-runway
   *  tolerance width (touchdownZonePairCountForLengthM pairs of TOUCHDOWN_ZONE_PAIR_SPACING_M)
   *  comes from this, same source and reasoning as src/renderer/src/touchdown-diagram.ts's
   *  identical touchdown-zone marking geometry. Null exactly when distanceFromAimingPointM is
   *  (no runway match, or a match with no real length data — resolveLandingScore folds both
   *  cases into the same null). */
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
  /** The real computed score — can go negative once the dangerous-exceedance deduction(s)
   *  apply (docs/decisions.md, 2026-09-20: "the overall score floors at 0 for display
   *  even though the math can go negative internally"). Flooring for display is the
   *  caller's job (src/main/db/landing-score-resolver.ts), not this function's — a
   *  negative value is real information (how far past dangerous this landing was), not
   *  a bug to hide here. */
  overall: number
  /** Every category whose deviation reached or exceeded its own tolerance this landing,
   *  mapped to its own scaled danger penalty (see dangerPenaltyForFraction's own doc
   *  comment) — i.e. where taperedScore would have gone negative before clamping to 0, not
   *  just "scored badly". Each entry's penalty is subtracted from `overall`, stacking when
   *  more than one category is this bad at once. Originally vertical-speed-only, a flat 20
   *  points (Callum's real example was an H category touchdown past 600fpm,
   *  landing-scoring-v2.md, 2026-09-20); generalised to every category 2026-09-21 after a
   *  real free-flight landing (VHHH, SF50) bottomed out both crab (-7.19°, tolerance 6.5°)
   *  and distance-from-aiming-point (~965m past the last real touchdown-zone pair)
   *  simultaneously with no visible penalty for either; then rescaled the same day from that
   *  flat 20 to a 1-10 range by how far past tolerance the deviation actually is (Callum:
   *  "not a fan of the flat -20 penalty... a landing that just grazes the danger line
   *  shouldn't cost the same as one that blew way past it"). Empty when nothing exceeded. */
  dangerPenalties: Partial<Record<LandingScoreCategoryKey, number>>
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
// Was 8 (range -4° to 12° nose-up). Tightened to 6, 2026-09-21 (Callum): the acceptable
// range should be -2° to 10° nose-up, with 4° staying the sweet spot — symmetric around the
// same ideal, just a narrower band either side of it.
const PITCH_TOLERANCE_DEG = 6
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
// from linear to quadratic (fraction^2) is deliberately gentler near ideal, which pushed 5°
// back up to 69 — silently undoing the exact real-incident fix above. 6.5 restored the same
// intent under that curve (5° -> 41, clearly under 50). Left unchanged when the curve was
// retuned again the same day from fraction^2 to fraction^1.5 (see taperedScore's own
// history) — 6.5 still keeps 5° comfortably under the bad threshold at the new exponent.
// Set to a flat 5, 2026-09-21: Callum's original intent (2026-09-12, above) was always that
// 5° should be *the* limit, not just comfortably under some other bad-threshold number — the
// 6.5 figure crept in only as a side effect of retuning the curve shape, not a deliberate
// choice to loosen the actual degree limit. 5 now means exactly what it says: 5° of residual
// crab at touchdown is the line, scoring exactly 0 and triggering the dangerous-exceedance
// penalty at that point, not somewhere past it.
const CRAB_TOLERANCE_DEG = 5

// ICAO Annex 14 §5.2.6 touchdown-zone marking — pair count by landing distance available
// (Manual of Aerodrome Standards table, same secondary source runway-lookup.ts's own
// aimingPointDistanceForLengthM already cites): <900m→1, <1200m→2, <1500m→3, <2400m→4,
// ≥2400m→6 pairs (no "5 pairs" band). Spaced every 150m, the first pair centred 150m from
// the (usable, displacement-adjusted) threshold — src/renderer/src/touchdown-diagram.ts's
// TouchdownDiagram draws these same real positions; this is the one shared home for both so
// the diagram's own real marking geometry and the score's distanceFromAimingPoint tolerance
// (pairCount * this spacing, computeLandingScore below) can never quietly drift apart (moved
// here from that file, 2026-09-13, when the score started needing the same real geometry).
// The score itself stopped using these as discrete steps 2026-09-21 (see taperedScore's own
// history) — they now only set how wide the tolerance is, same as every other category.
export const TOUCHDOWN_ZONE_PAIR_SPACING_M = 150

export function touchdownZonePairCountForLengthM(lengthM: number): number {
  if (lengthM < 900) return 1
  if (lengthM < 1200) return 2
  if (lengthM < 1500) return 3
  if (lengthM < 2400) return 4
  return 6
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
// landing to calibrate the shape against — a tapered curve, gentle near ideal and steep
// near/past tolerance, replacing the old straight-line taper. Was called linearScore;
// renamed since it's no longer linear. The exponent was first tried as a full square
// (quadratic — fraction^2), but a real BAW32 flight the same day showed it was too
// generous through the *middle* of the range: a touchdown vertical speed and a crab both
// only halfway through their tolerance still scored ~76-78/100, not the ~50 "halfway
// should feel like half" a real pilot expected (Callum, 2026-09-20). Retuned that same day
// to fraction^1.5 — still gentler than a straight line near ideal (a small deviation barely
// moves the score) but far less generous through the middle than squaring was (halfway
// through tolerance now scores ~65, not ~76).
/** Tapered falloff to 0 at `tolerance` past `ideal` (deviation already `actual - ideal`),
 *  clamped to [0,100] so a single input can never go negative on its own. Raising the
 *  fraction of tolerance used to a power > 1 means a small deviation barely moves the score
 *  (flat near ideal) while the same absolute step matters more as it approaches tolerance
 *  (steeper near/past it) — the opposite shape from a straight-line taper, which penalizes
 *  every increment equally regardless of how close to ideal it started. The exponent
 *  controls how much of that "flat near ideal" character survives into the middle of the
 *  range — see this function's own history above for why 1.5 replaced a full square. */
const TAPER_EXPONENT = 1.5

interface CategoryScore {
  score: number
  /** True when `deviation` reached or passed `tolerance` — i.e. the raw curve would have
   *  gone negative before clamping to 0, not just landed on a low-but-still-nonzero score.
   *  Feeds `dangerPenalties` below (2026-09-21). */
  exceeded: boolean
  /** 0 when not `exceeded`; otherwise this category's own scaled penalty — see
   *  dangerPenaltyForFraction's own doc comment. */
  dangerPenalty: number
}

// A deviation that's only just crossed into "dangerous" (fraction just past 1 — barely at
// the category's own hard limit) shouldn't cost the same as one that blew well past it.
// Scaled linearly from DANGER_PENALTY_MIN at fraction 1.0 to DANGER_PENALTY_MAX at fraction
// maxFraction and beyond — Callum's own calibration, 2026-09-21, replacing a flat 20-point
// hit regardless of how far over the line a landing actually was. First tried as one number
// (1.5, then tightened to 1.25 the same day — "the penalty should get higher quicker") for
// every category, but real testing showed the two didn't suit each other: distance-from-
// aiming-point felt right maxing out fast (1.25 — a long landing is dangerous quickly, so it
// should bite hard soon after crossing the line), while crab felt too harsh at that same
// pace and wanted the gentler 1.5 ramp back. `maxFraction` is now per category rather than
// one shared constant for exactly that reason.
const DANGER_PENALTY_MIN = 1
const DANGER_PENALTY_MAX = 10
const DEFAULT_DANGER_PENALTY_MAX_FRACTION = 1.25
// Crab's own ramp is gentler than the default — see the history above.
const CRAB_DANGER_PENALTY_MAX_FRACTION = 1.5

function dangerPenaltyForFraction(fraction: number, maxFraction: number): number {
  if (fraction < 1) return 0
  const severity = Math.min(1, (fraction - 1) / (maxFraction - 1))
  return Math.round(DANGER_PENALTY_MIN + severity * (DANGER_PENALTY_MAX - DANGER_PENALTY_MIN))
}

function taperedScore(
  deviation: number,
  tolerance: number,
  maxFraction: number = DEFAULT_DANGER_PENALTY_MAX_FRACTION
): CategoryScore {
  const magnitude = Math.abs(deviation)
  if (tolerance <= 0) {
    const exceeded = magnitude !== 0
    return { score: exceeded ? 0 : 100, exceeded, dangerPenalty: exceeded ? DANGER_PENALTY_MAX : 0 }
  }
  const fraction = magnitude / tolerance
  const score = Math.max(0, Math.min(100, Math.round(100 * (1 - fraction ** TAPER_EXPONENT))))
  const exceeded = fraction >= 1
  return { score, exceeded, dangerPenalty: exceeded ? dangerPenaltyForFraction(fraction, maxFraction) : 0 }
}

/**
 * The 0-100 landing score (0-100 for display; see LandingScoreBreakdown's own doc comment
 * on `overall` for why the raw value here can be negative). Each of the 7 inputs is scored
 * and clamped to [0,100] independently before combining, so no single input can drag
 * `overall` negative on its own — only the separate dangerous-exceedance deduction(s) can
 * (landing-scoring-v2.md, 2026-09-20, reopening docs/decisions.md's 2026-09-12 "no separate
 * dangerous floor step" — v1 deliberately had none; v2 added one, per category, on purpose).
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

  const gForce = taperedScore(inputs.gForce - GFORCE_IDEAL, GFORCE_TOLERANCE)
  const pitch = taperedScore(inputs.pitchDeg - PITCH_IDEAL_DEG, PITCH_TOLERANCE_DEG)
  const bank = taperedScore(inputs.bankDeg - BANK_IDEAL_DEG, BANK_TOLERANCE_DEG)
  const crab =
    inputs.crabDeg === null
      ? null
      : taperedScore(inputs.crabDeg - CRAB_IDEAL_DEG, CRAB_TOLERANCE_DEG, CRAB_DANGER_PENALTY_MAX_FRACTION)
  const touchdownZonePairCount =
    inputs.runwayLengthM === null ? null : touchdownZonePairCountForLengthM(inputs.runwayLengthM)
  const distanceFromAimingPointTolerance =
    touchdownZonePairCount === null ? null : touchdownZonePairCount * TOUCHDOWN_ZONE_PAIR_SPACING_M
  const distanceFromAimingPoint =
    inputs.distanceFromAimingPointM === null || distanceFromAimingPointTolerance === null
      ? null
      : taperedScore(inputs.distanceFromAimingPointM, distanceFromAimingPointTolerance)
  const centrelineOffset =
    inputs.centrelineOffsetM === null || inputs.centrelineToleranceM === null
      ? null
      : taperedScore(inputs.centrelineOffsetM, inputs.centrelineToleranceM)

  const scored: { key: LandingScoreCategoryKey; weight: number; result: CategoryScore | null }[] = [
    { key: 'verticalSpeed', weight: WEIGHTS.verticalSpeed, result: verticalSpeed },
    { key: 'gForce', weight: WEIGHTS.gForce, result: gForce },
    { key: 'distanceFromAimingPoint', weight: WEIGHTS.distanceFromAimingPoint, result: distanceFromAimingPoint },
    { key: 'centrelineOffset', weight: WEIGHTS.centrelineOffset, result: centrelineOffset },
    { key: 'pitch', weight: WEIGHTS.pitch, result: pitch },
    { key: 'bank', weight: WEIGHTS.bank, result: bank },
    { key: 'crab', weight: WEIGHTS.crab, result: crab }
  ]

  let weightedSum = 0
  let availableWeight = 0
  let totalDangerPenalty = 0
  const dangerPenalties: Partial<Record<LandingScoreCategoryKey, number>> = {}
  for (const { key, weight, result } of scored) {
    if (result === null) continue
    weightedSum += weight * result.score
    availableWeight += weight
    if (result.exceeded) {
      dangerPenalties[key] = result.dangerPenalty
      totalDangerPenalty += result.dangerPenalty
    }
  }
  const weightedOverall = availableWeight === 0 ? 0 : Math.round(weightedSum / availableWeight)
  const overall = weightedOverall - totalDangerPenalty

  return {
    overall,
    dangerPenalties,
    inputs: {
      verticalSpeed: verticalSpeed.score,
      gForce: gForce.score,
      distanceFromAimingPoint: distanceFromAimingPoint?.score ?? null,
      centrelineOffset: centrelineOffset?.score ?? null,
      pitch: pitch.score,
      bank: bank.score,
      crab: crab?.score ?? null
    },
    details: {
      verticalSpeed: { ideal: band.sweetSpotFpm, tolerance: verticalSpeedTolerance },
      gForce: { ideal: GFORCE_IDEAL, tolerance: GFORCE_TOLERANCE },
      pitch: { ideal: PITCH_IDEAL_DEG, tolerance: PITCH_TOLERANCE_DEG },
      bank: { ideal: BANK_IDEAL_DEG, tolerance: BANK_TOLERANCE_DEG },
      crab: inputs.crabDeg === null ? null : { ideal: CRAB_IDEAL_DEG, tolerance: CRAB_TOLERANCE_DEG },
      distanceFromAimingPoint:
        distanceFromAimingPointTolerance === null ? null : { ideal: 0, tolerance: distanceFromAimingPointTolerance },
      centrelineOffset:
        inputs.centrelineToleranceM === null ? null : { ideal: 0, tolerance: inputs.centrelineToleranceM }
    }
  }
}
