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
 * "What would a perfect value look like on this flight" — real per-flight numbers where
 * that's meaningful, not a generic description: centrelineOffset's tolerance comes from this
 * specific runway's own real width (Callum's request, 2026-09-12). distanceFromAimingPoint's
 * `ideal`/`tolerance` are gated on having a real runway match (same null-handling as the
 * rest) but the scale itself is a fixed stepped one, not runway data (2026-09-13 — see
 * touchdownZoneScore's own doc comment in @shared/landing-score). `ideal`/`tolerance` are
 * null exactly when the category itself has no runway match to compute them from.
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
      return `Ideal: ${ideal}° (crab removed by touchdown). Score reaches 0 at ±${tolerance}°.`
    case 'distanceFromAimingPoint': {
      // Stepped, not a smooth taper (landing-score.ts's touchdownZoneScore, 2026-09-13) —
      // matches how touchdown-zone markings actually read in real life: which pair of piano
      // keys you landed within, not a continuous distance. `tolerance` is always 3 equal
      // bands (Callum's own spec), so the two intermediate boundaries are exact thirds of it.
      const firstBoundary = formatRunwayDistance(tolerance / 3, unit)
      const secondBoundary = formatRunwayDistance((tolerance * 2) / 3, unit)
      const outerBoundary = formatRunwayDistance(tolerance, unit)
      return `Ideal: touchdown on the aiming point, either direction. Within ${firstBoundary}: perfect. Out to ${secondBoundary}: 2 points off (of 10). Out to ${outerBoundary}: 4 points off. Beyond that: 0 — off the graded touchdown zone entirely.`
    }
    case 'centrelineOffset':
      return `Ideal: on the centreline. Score reaches 0 at ${formatRunwayDistance(tolerance, unit)} off it — half this runway's real width.`
  }
}
