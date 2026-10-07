/**
 * Renderer-only display helpers for the landing score (docs/decisions.md, 2026-09-12) —
 * split out of LandingScoreBreakdownDialog.tsx so that file stays components-only
 * (react-refresh/only-export-components; the same reason LandingBadge.tsx doesn't export
 * its own threshold constants either).
 */

import type { LandingDistanceUnit, LandingScoreCategoryKey } from '@shared/ipc'
import { formatRunwayDistance } from './units'

/** A category below this (0-100) reads as a real drag on the score, not just short of
 *  perfect — same boundary LandingScoreBadge uses for its own "fair" band, so the warning
 *  icon and the badge's colour band agree about what counts as bad. */
export const BAD_CATEGORY_THRESHOLD = 50

/**
 * Whether a category drags the score down (below BAD_CATEGORY_THRESHOLD).
 *
 * @param score The category's 0-100 score, or null.
 * @returns True if it is low enough to flag.
 */
export function isCategoryBad(score: number | null): boolean {
  return score !== null && score < BAD_CATEGORY_THRESHOLD
}

/**
 * A category's own 0-100 contribution, rescaled onto a plain 0-10 rating — e.g. a score of
 * 89 reads as "9/10". This intentionally drops each category's real weight in the overall
 * formula (verticalSpeed counts for more than crab there): a first pass showed each row's
 * actual weighted contribution instead and Callum found it more confusing than useful — "I
 * know that's not the formula overall but it would be more representative to the user" — so
 * this favours the simpler, more intuitive reading over formula-accuracy for this one
 * display (docs/decisions.md, 2026-09-12). The overall 0-100 score is still the real,
 * correctly-weighted number; this is just how each input reads on its own.
 *
 * @param score The category's 0-100 score.
 * @returns The 0-10 rating.
 */
export function categoryScoreOutOf10(score: number): number {
  return Math.round(score / 10)
}

/**
 * A category's rating as shown in the breakdown.
 *
 * @param score The category's 0-100 score, or null.
 * @returns The rating out of 10, or "N/A".
 */
export function formatCategoryScore(score: number | null): string {
  return score === null ? 'N/A' : String(categoryScoreOutOf10(score))
}

/**
 * "What would a perfect value look like on this flight" — real per-flight numbers where
 * that's meaningful, not a generic description: centrelineOffset's tolerance comes from this
 * specific runway's own real width (Callum's request, 2026-09-12), and
 * distanceFromAimingPoint's from this runway's own real touchdown-zone marking extent
 * (touchdownZonePairCountForLengthM pairs of TOUCHDOWN_ZONE_PAIR_SPACING_M — 2026-09-13).
 * Both are gated on having a real runway match (same null-handling as the rest); `ideal`/
 * `tolerance` are null exactly when the category itself has no runway match to compute them
 * from.
 *
 * @param key The category.
 * @param ideal Its ideal value, or null.
 * @param tolerance Its tolerance, or null.
 * @param unit The distance unit to show.
 * @param toleranceShort The short-side tolerance, for the aiming point.
 * @param toleranceLong The long-side tolerance, for the aiming point.
 * @returns The description.
 */
export function describeCategoryTolerance(
  key: LandingScoreCategoryKey,
  ideal: number | null,
  tolerance: number | null,
  unit: LandingDistanceUnit,
  toleranceShort: number | null = null,
  toleranceLong: number | null = null
): string {
  if (ideal === null || tolerance === null) return 'Not available for this landing — no matched runway.'
  switch (key) {
    case 'verticalSpeed':
      // Symmetric around the sweet spot (landing-score.ts, 2026-09-13), but the tolerance is
      // wide enough that the "below" zero point always falls at or under 0 fpm — i.e. never
      // reachable in practice, since fpm can't go negative. Deliberate: touching down softer
      // than the sweet spot is barely penalized, only firmer-than-ideal actually fails.
      return `Sweet spot: ${Math.round(ideal)} fpm for this aircraft's wake category. A softer touchdown is barely penalized — score only reaches 0 if too firm, at ${Math.round(ideal + tolerance)} fpm.`
    case 'gForce':
      return `Ideal: ${ideal.toFixed(1)} g. Score reaches 0 at ${(ideal - tolerance).toFixed(1)} g or ${(ideal + tolerance).toFixed(1)} g.`
    case 'pitch': {
      // `ideal` here is landing-score.ts's PITCH_IDEAL_DEG, in the SimVar's own sign
      // convention (negative = nose-up — see formatPitchDeg's doc comment in units.ts).
      // Negating it for display reads as a normal pilot would say it (a positive "4°
      // nose-up"), not backwards (Callum, 2026-09-13: "I think you forgot to flip the
      // value"). The ± tolerance band is unaffected by the sign flip since it's symmetric
      // around ideal either way.
      const displayIdeal = -ideal
      return `Ideal: ${displayIdeal}° nose-up. Score reaches 0 at ${displayIdeal - tolerance}° or ${displayIdeal + tolerance}°.`
    }
    case 'bank':
      return `Ideal: ${ideal}° (wings level). Score reaches 0 at ±${tolerance}°.`
    case 'crab':
      return `Ideal: ${ideal}°. Score reaches 0 at ±${tolerance}°.`
    case 'distanceFromAimingPoint':
      // Was a stepped scale (piano-key bands) until 2026-09-21, when Callum pointed out it
      // made some scores impossible to land on and asked for the same tapered logic as every
      // other category. Asymmetric since 2026-09-26 (Callum) — the aiming point isn't
      // symmetric between the runway's two real hard limits, so a single ± tolerance either
      // read as too lenient toward the threshold or too harsh toward the far marker
      // depending which one it was tuned to. toleranceShort/toleranceLong are null together
      // with `tolerance` above, so this case is only reached with both real.
      return `Ideal: touchdown on the aiming point. Score reaches 0 at the threshold (${formatRunwayDistance(toleranceShort ?? 0, unit)} short of the aiming point) or at ${formatRunwayDistance(toleranceLong ?? 0, unit)} past it — this runway's own real touchdown-zone marking extent.`
    case 'centrelineOffset':
      return `Ideal: on the centreline. Score reaches 0 at ${formatRunwayDistance(tolerance, unit)} off it — half this runway's real width.`
  }
}
