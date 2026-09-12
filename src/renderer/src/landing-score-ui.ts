// Renderer-only display helpers for the landing score (docs/decisions.md, 2026-09-12) —
// split out of LandingScoreBreakdownDialog.tsx so that file stays components-only
// (react-refresh/only-export-components; the same reason LandingBadge.tsx doesn't export
// its own threshold constants either).
import type { LandingDistanceUnit, LandingScoreCategoryKey } from '@shared/ipc'
import { formatRunwayDistance } from './units'

/** A category below this (0-100) reads as a real drag on the score, not just short of
 *  perfect — same boundary LandingScoreBadge uses for its own "fair" band, so the warning
 *  icon and the badge's colour band agree about what counts as bad. */
export const BAD_CATEGORY_THRESHOLD = 50

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
 */
export function categoryScoreOutOf10(score: number): number {
  return Math.round(score / 10)
}

export function formatCategoryScore(score: number | null): string {
  return score === null ? 'N/A' : String(categoryScoreOutOf10(score))
}

/**
 * "What would a perfect value look like on this flight" — real per-flight numbers, not a
 * generic description, since two of these (the aiming point and centreline tolerances) come
 * from this specific runway's own real Annex-14/width data and vary flight to flight
 * (Callum's request, 2026-09-12). `ideal`/`tolerance` are null exactly when the category
 * itself has no runway match to compute them from.
 */
export function describeCategoryTolerance(
  key: LandingScoreCategoryKey,
  ideal: number | null,
  tolerance: number | null,
  unit: LandingDistanceUnit
): string {
  if (ideal === null || tolerance === null) return 'Not available for this landing — no matched runway.'
  switch (key) {
    case 'verticalSpeed':
      return `Ideal: at or under ${Math.round(ideal)} fpm for this aircraft's wake category. Score reaches 0 at ${Math.round(ideal + tolerance)} fpm.`
    case 'gForce':
      return `Ideal: ${ideal.toFixed(1)} g. Score reaches 0 at ${(ideal - tolerance).toFixed(1)} g or ${(ideal + tolerance).toFixed(1)} g.`
    case 'pitch':
      return `Ideal: ${ideal}° (nose-up flare). Score reaches 0 at ${ideal - tolerance}° or ${ideal + tolerance}°.`
    case 'bank':
      return `Ideal: ${ideal}° (wings level). Score reaches 0 at ±${tolerance}°.`
    case 'crab':
      return `Ideal: ${ideal}° (crab removed by touchdown). Score reaches 0 at ±${tolerance}°.`
    case 'distanceFromAimingPoint':
      return `Ideal: touchdown on the aiming point. Score reaches 0 at ${formatRunwayDistance(tolerance, unit)} off it — this runway's own real aiming-point distance from the threshold.`
    case 'centrelineOffset':
      return `Ideal: on the centreline. Score reaches 0 at ${formatRunwayDistance(tolerance, unit)} off it — half this runway's real width.`
  }
}
