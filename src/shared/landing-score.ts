/**
 * Landing score (0-100, floored for display): winglog-backend's docs/plans/landing-scoring.md and
 * landing-scoring-v2.md. A tapered falloff (fraction^1.5, see taperedScore) plus a separate
 * dangerous-exceedance deduction. Pure, no I/O: used by the main process (which resolves the
 * runway and wake-category lookups from vendored data, src/main/db/landing-score-resolver.ts) and
 * by the renderer for rendering and tests only.
 */

import type { LandingScoreCategoryKey, LandingSeverity } from './ipc'
import { msToFpm } from './units'

export type WakeCategory = 'L' | 'M' | 'H' | 'J'

/**
 * Touchdown vertical-speed sweet spots per ICAO wake-turbulence category (resources/icao-aircraft-types.csv's
 * `wtc` column): judgement calls, not per-type manufacturer figures (decisions.md, 2026-09-12).
 * `minFpm`/`maxFpm` are the category's labelled ideal range, kept as reference data. The score's
 * tolerance (see computeLandingScore) is wider and symmetric around `sweetSpotFpm`, because a
 * touchdown just under the labelled range is still a gentle landing. J (only the A380) shares H's
 * range, with a sweet spot 10 fpm higher for its longer-travel gear.
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

/**
 * @param category The aircraft's wake category, or null if unknown.
 * @returns Its touchdown rate band; an unknown category gets M's.
 */
export function landingRateBand(category: WakeCategory | null): LandingRateBand {
  return LANDING_RATE_BANDS[category ?? UNKNOWN_CATEGORY_FALLBACK]
}

export interface LandingThresholds {
  firmFpm: number
  hardFpm: number
}

// Firm and hard derive from the category's own ideal, not a user setting (decisions.md, 2026-09-12).
// The multipliers are judgement calls, like LANDING_RATE_BANDS above.
const FIRM_MULTIPLIER = 2.5
const HARD_MULTIPLIER = 4.0

/**
 * @param category The aircraft's wake category, or null if unknown.
 * @returns The firm and hard touchdown rates for it.
 */
export function deriveLandingThresholds(category: WakeCategory | null): LandingThresholds {
  const ideal = landingRateBand(category).sweetSpotFpm
  return { firmFpm: ideal * FIRM_MULTIPLIER, hardFpm: ideal * HARD_MULTIPLIER }
}


/**
 * Classifies a touchdown against derived thresholds. Vertical speed is negative
 * (descending) — classified on magnitude, since a "harder" landing is a larger descent
 * rate regardless of sign convention. Moved verbatim from the old
 * src/renderer/src/landing-severity.ts (same signature/behaviour) — only where its
 * `thresholds` argument comes from has changed.
 *
 * @param touchdownVerticalSpeedMs Vertical speed at touchdown, in m/s.
 * @param thresholds The firm and hard rates.
 * @returns How firm the landing was.
 */
export function classifyLanding(
  touchdownVerticalSpeedMs: number,
  thresholds: LandingThresholds
): LandingSeverity {
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
  /** This runway end's ICAO Annex 14 aiming-point marking distance from the threshold
   *  (runway-lookup.ts's aimingPointDistanceForLengthM). distanceFromAimingPoint is the only category
   *  with two hard limits rather than one symmetric tolerance: touching down at the threshold scores 0
   *  (too short), and at the last touchdown-zone marker scores 0 (too long). The aiming point sits
   *  between them, usually off-centre (150-400 m from the threshold). computeLandingScore scores it
   *  against `aimingPointDistanceM` toward the threshold, and against
   *  touchdownZonePairCountForLengthM(runwayLengthM) pairs of TOUCHDOWN_ZONE_PAIR_SPACING_M minus
   *  `aimingPointDistanceM` away from it. Null in the same cases as runwayLengthM (no runway match, or
   *  no aiming-point data). */
  aimingPointDistanceM: number | null
  /** Signed lateral offset from the runway centreline (0 = dead centre). */
  centrelineOffsetM: number | null
  /** Where the centreline input's score hits 0 — half the runway's real width, or
   *  runway-lookup.ts's FALLBACK_LATERAL_TOLERANCE_M when width is unknown. Null exactly
   *  when centrelineOffsetM is null (no runway match at all). */
  centrelineToleranceM: number | null
}

/** What "perfect" and "score reaches 0" are for one category, in its natural unit (fpm, degrees, g or
 *  metres): per-flight numbers for the two runway-dependent categories (centrelineOffset's tolerance
 *  is this runway's half-width). Symmetric for every category except distanceFromAimingPoint (see
 *  aimingPointDistanceM), where `tolerance` holds one representative value (the long side) for any
 *  generic consumer, and `toleranceShort`/`toleranceLong` carry the real asymmetric pair. */
export interface LandingScoreCategoryDetail {
  ideal: number
  /** Deviation from `ideal` (same unit) at which this category's score reaches 0. For
   *  distanceFromAimingPoint specifically, this equals `toleranceLong` — see this
   *  interface's own doc comment above. */
  tolerance: number
  /** distanceFromAimingPoint only — the real tolerance toward the threshold (touching down
   *  short of the aiming point). null for every other category. */
  toleranceShort: number | null
  /** distanceFromAimingPoint only — the real tolerance away from the threshold (touching
   *  down long of the aiming point) — the same value as `tolerance` above. null for every
   *  other category. */
  toleranceLong: number | null
}

export interface LandingScoreBreakdown {
  /** The computed score. It can go negative once the dangerous-exceedance deduction(s) apply
   *  (decisions.md, 2026-09-20). Flooring for display is the caller's job
   *  (src/main/db/landing-score-resolver.ts): a negative value says how far past dangerous the
   *  landing was. */
  overall: number
  /** Every category whose deviation reached its tolerance, with its scaled danger penalty (see
   *  dangerPenaltyForFraction): where taperedScore would have gone negative before clamping, not just
   *  "scored badly". Each penalty is subtracted from `overall`, stacking when several categories are
   *  this bad at once (landing-scoring-v2.md; decisions.md, 2026-09-20 and 2026-09-21). Empty when
   *  nothing exceeded. */
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
// MSFS's PLANE PITCH DEGREES (simvars.ts) is negative for nose-up and positive for nose-down
// (simconnect-notes.md, 2026-09-03: -6.709° at a real touchdown), so a "4° nose-up" ideal flare is
// -4 here, not +4.
const PITCH_IDEAL_DEG = -4
// A tolerance of 6 gives -2° to 10° nose-up around the 4° sweet spot.
const PITCH_TOLERANCE_DEG = 6
const BANK_IDEAL_DEG = 0
const BANK_TOLERANCE_DEG = 8
const CRAB_IDEAL_DEG = 0
// Past ~5° of residual crab at touchdown is worth a warning, since technique guidance has the pilot
// removing crab by touchdown (decisions.md, 2026-09-12). 5 is the limit itself: 5° scores exactly 0
// and triggers the dangerous-exceedance penalty at that point. (Earlier values were 15, 9 and 6.5;
// the curve shape had moved the effective limit, see landing-scoring-v2.md.)
const CRAB_TOLERANCE_DEG = 5

// ICAO Annex 14 §5.2.6 touchdown-zone marking: pair count by landing distance available (Manual of
// Aerodrome Standards table, the same source as runway-lookup.ts's aimingPointDistanceForLengthM):
// <900m→1, <1200m→2, <1500m→3, <2400m→4, ≥2400m→6 pairs (no "5 pairs" band). Spaced every 150m, the
// first pair centred 150m from the (usable, displacement-adjusted) threshold. touchdown-diagram.ts's
// TouchdownDiagram draws these same positions, and the score's distanceFromAimingPoint tolerance uses
// them too, so this is their one shared home. They set how wide the tolerance is; the score itself is
// not stepped.
export const TOUCHDOWN_ZONE_PAIR_SPACING_M = 150

/**
 * @param lengthM The runway's length, in metres.
 * @returns How many touchdown-zone marking pairs a runway that long has.
 */
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

// Landing scoring v2 (landing-scoring-v2.md): a tapered falloff, gentle near ideal and steep near and
// past tolerance, replacing the straight-line taper. The exponent is 1.5: a full square was too
// generous through the middle (halfway through tolerance still scored ~76, where ~50 was expected);
// 1.5 gives ~65.
/** Tapered falloff to 0 at `tolerance` past `ideal` (deviation already `actual - ideal`), clamped to
 *  [0,100] so a single input can never go negative on its own. Raising the fraction of tolerance used
 *  to a power > 1 keeps the score flat near ideal and steeper as it approaches tolerance, the opposite
 *  of a straight-line taper. */
const TAPER_EXPONENT = 1.5

interface CategoryScore {
  score: number
  /** True when `deviation` reached or passed `tolerance`: the raw curve would have gone negative before
   *  clamping to 0. Feeds `dangerPenalties` below. */
  exceeded: boolean
  /** 0 when not `exceeded`; otherwise this category's own scaled penalty — see
   *  dangerPenaltyForFraction's own doc comment. */
  dangerPenalty: number
}

// A deviation just past the category's hard limit shouldn't cost the same as one that blew well past
// it: the penalty scales linearly from DANGER_PENALTY_MIN at fraction 1.0 to DANGER_PENALTY_MAX at
// `maxFraction` and beyond. `maxFraction` is per category because they ramp differently:
// distance-from-aiming-point maxes out fast, crab wants the gentler ramp.
const DANGER_PENALTY_MIN = 1
const DANGER_PENALTY_MAX = 10
const DEFAULT_DANGER_PENALTY_MAX_FRACTION = 1.25
// Crab's own ramp is gentler than the default — see the history above.
const CRAB_DANGER_PENALTY_MAX_FRACTION = 1.5
// distanceFromAimingPoint's ramp is loosened to crab's 1.5 (the default is 1.25): against the correct
// ~500m long-side tolerance, 1.25 scored a 5-point penalty ~55m past the last touchdown-zone marker,
// which was harsh. 1.5 gives roughly half that.
const DISTANCE_FROM_AIMING_POINT_DANGER_PENALTY_MAX_FRACTION = 1.5

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
 * distanceFromAimingPoint's own scoring, the one category taperedScore alone can't cover: it has two
 * hard limits (the threshold, and the last touchdown-zone marker), not one tolerance either side of
 * `ideal` (0 = the aiming point); see aimingPointDistanceM. `deviation` is signed `actual - ideal`:
 * negative is short of the aiming point, so the sign picks which tolerance applies, and past that it
 * is the same tapered curve as every other category.
 *
 * @param deviation Distance from the aiming point, in metres; negative is short.
 * @param toleranceShort The tolerance short of the aiming point.
 * @param toleranceLong The tolerance long of it.
 * @param maxFraction How far past the tolerance the danger penalty reaches its maximum.
 * @returns The category's score.
 */
function asymmetricTaperedScore(
  deviation: number,
  toleranceShort: number,
  toleranceLong: number,
  maxFraction: number
): CategoryScore {
  return taperedScore(deviation, deviation <= 0 ? toleranceShort : toleranceLong, maxFraction)
}

/**
 * The 0-100 landing score (see LandingScoreBreakdown's `overall` for why the raw value can be
 * negative). Each of the 7 inputs is scored and clamped to [0,100] independently before combining, so
 * only the separate dangerous-exceedance deduction(s) can take `overall` negative
 * (landing-scoring-v2.md; decisions.md, 2026-09-20).
 *
 * @param inputs The touchdown's measurements, with null for any the landing doesn't have.
 * @returns The overall score and each category's part in it.
 */
export function computeLandingScore(inputs: LandingScoreInputs): LandingScoreBreakdown {
  const thresholds = deriveLandingThresholds(inputs.category)
  const band = landingRateBand(inputs.category)
  const actualFpm = Math.abs(msToFpm(inputs.verticalSpeedMs))
  // Two-sided: peaks at the category's sweet spot and decays symmetrically either side (landing-scoring.md,
  // "fpm sweet spots"). The tolerance is the same distance out as the derived hard-landing threshold, so a
  // touchdown a little under the labelled range still scores well: there is no safety case for punishing
  // "too soft" as hard as "too firm".
  const verticalSpeedTolerance = thresholds.hardFpm - band.sweetSpotFpm
  const verticalSpeed = taperedScore(actualFpm - band.sweetSpotFpm, verticalSpeedTolerance)

  const gForce = taperedScore(inputs.gForce - GFORCE_IDEAL, GFORCE_TOLERANCE)
  const pitch = taperedScore(inputs.pitchDeg - PITCH_IDEAL_DEG, PITCH_TOLERANCE_DEG)
  const bank = taperedScore(inputs.bankDeg - BANK_IDEAL_DEG, BANK_TOLERANCE_DEG)
  const crab =
    inputs.crabDeg === null
      ? null
      : taperedScore(inputs.crabDeg - CRAB_IDEAL_DEG, CRAB_TOLERANCE_DEG, CRAB_DANGER_PENALTY_MAX_FRACTION)
  const aimingPoint = aimingPointTolerances(inputs)
  const distanceFromAimingPoint =
    inputs.distanceFromAimingPointM === null || aimingPoint === null
      ? null
      : asymmetricTaperedScore(
          inputs.distanceFromAimingPointM,
          aimingPoint.short,
          aimingPoint.long,
          DISTANCE_FROM_AIMING_POINT_DANGER_PENALTY_MAX_FRACTION
        )
  const centrelineOffset =
    inputs.centrelineOffsetM === null || inputs.centrelineToleranceM === null
      ? null
      : taperedScore(inputs.centrelineOffsetM, inputs.centrelineToleranceM)

  const { overall, dangerPenalties } = combineScores([
    { key: 'verticalSpeed', weight: WEIGHTS.verticalSpeed, result: verticalSpeed },
    { key: 'gForce', weight: WEIGHTS.gForce, result: gForce },
    {
      key: 'distanceFromAimingPoint',
      weight: WEIGHTS.distanceFromAimingPoint,
      result: distanceFromAimingPoint
    },
    { key: 'centrelineOffset', weight: WEIGHTS.centrelineOffset, result: centrelineOffset },
    { key: 'pitch', weight: WEIGHTS.pitch, result: pitch },
    { key: 'bank', weight: WEIGHTS.bank, result: bank },
    { key: 'crab', weight: WEIGHTS.crab, result: crab }
  ])

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
    details: scoreDetails(
      inputs,
      { ideal: band.sweetSpotFpm, tolerance: verticalSpeedTolerance },
      aimingPoint
    )
  }
}

/**
 * distanceFromAimingPoint's two tolerances (see aimingPointDistanceM). Toward the threshold it is the
 * aiming point's own distance from it, so the score reaches 0 at the threshold. Away from it, it is the
 * gap from the aiming point to the last touchdown-zone marker (touchdownZonePairCount * 150m minus the
 * aiming point's), clamped at 0 for the short-runway band where the aiming point sits beyond the single
 * touchdown-zone pair (800-900m runways: 1 pair at 150m, aiming point at 250m); taperedScore scores any
 * deviation against a zero tolerance as 0.
 *
 * @param inputs The touchdown's measurements.
 * @returns The short and long tolerances in metres, or null without the runway's length or
 *   aiming point.
 */
function aimingPointTolerances(inputs: LandingScoreInputs): { short: number; long: number } | null {
  if (inputs.runwayLengthM === null || inputs.aimingPointDistanceM === null) return null
  const touchdownZonePairCount = touchdownZonePairCountForLengthM(inputs.runwayLengthM)
  return {
    short: inputs.aimingPointDistanceM,
    long: Math.max(0, touchdownZonePairCount * TOUCHDOWN_ZONE_PAIR_SPACING_M - inputs.aimingPointDistanceM)
  }
}

/** One category's weight in the overall score, and its score (null when not scored). */
interface WeightedCategory {
  key: LandingScoreCategoryKey
  weight: number
  result: CategoryScore | null
}

/**
 * The weighted average of the categories that could be scored (renormalised over their
 * weights), minus every dangerous-exceedance penalty.
 *
 * @param scored Every category, scored or not.
 * @returns The overall score, and each exceeded category's penalty.
 */
function combineScores(
  scored: WeightedCategory[]
): Pick<LandingScoreBreakdown, 'overall' | 'dangerPenalties'> {
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
  return { overall: weightedOverall - totalDangerPenalty, dangerPenalties }
}

/**
 * The ideal and tolerance each category was scored against, for the breakdown popup.
 *
 * @param inputs The touchdown's measurements.
 * @param verticalSpeed The category's sweet spot and tolerance, in fpm.
 * @param aimingPoint The aiming point's tolerances, or null.
 * @returns The details, with null for a category that wasn't scored.
 */
function scoreDetails(
  inputs: LandingScoreInputs,
  verticalSpeed: { ideal: number; tolerance: number },
  aimingPoint: { short: number; long: number } | null
): LandingScoreBreakdown['details'] {
  return {
    verticalSpeed: { ...verticalSpeed, toleranceShort: null, toleranceLong: null },
    gForce: { ideal: GFORCE_IDEAL, tolerance: GFORCE_TOLERANCE, toleranceShort: null, toleranceLong: null },
    pitch: {
      ideal: PITCH_IDEAL_DEG,
      tolerance: PITCH_TOLERANCE_DEG,
      toleranceShort: null,
      toleranceLong: null
    },
    bank: { ideal: BANK_IDEAL_DEG, tolerance: BANK_TOLERANCE_DEG, toleranceShort: null, toleranceLong: null },
    crab:
      inputs.crabDeg === null
        ? null
        : { ideal: CRAB_IDEAL_DEG, tolerance: CRAB_TOLERANCE_DEG, toleranceShort: null, toleranceLong: null },
    distanceFromAimingPoint:
      aimingPoint === null
        ? null
        : {
            ideal: 0,
            tolerance: aimingPoint.long,
            toleranceShort: aimingPoint.short,
            toleranceLong: aimingPoint.long
          },
    centrelineOffset:
      inputs.centrelineToleranceM === null
        ? null
        : { ideal: 0, tolerance: inputs.centrelineToleranceM, toleranceShort: null, toleranceLong: null }
  }
}
