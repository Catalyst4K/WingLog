// Renderer-only display helpers for the landing score (docs/decisions.md, 2026-09-12) —
// split out of LandingScoreBreakdownDialog.tsx so that file stays components-only
// (react-refresh/only-export-components; the same reason LandingBadge.tsx doesn't export
// its own threshold constants either).

/** A category below this (0-100) reads as a real drag on the score, not just short of
 *  perfect — same boundary LandingScoreBadge uses for its own "fair" band, so the warning
 *  icon and the badge's colour band agree about what counts as bad. */
export const BAD_CATEGORY_THRESHOLD = 50

export function isCategoryBad(score: number | null): boolean {
  return score !== null && score < BAD_CATEGORY_THRESHOLD
}

/** A category's own ceiling on the popup's 0-to-10 scale — its `weight` out of the 100
 *  the 7 categories sum to, rescaled onto 10 (so the ceilings themselves sum to 10). Shown
 *  as each row's denominator instead of a flat "/10" for every row (see deductionOutOf10's
 *  comment for why a flat scale was actually wrong, not just a stylistic choice). */
export function categoryMaxPoints(weight: number): number {
  return weight / 10
}

/**
 * Each category's actual contribution to the overall score's shortfall from 100, out of
 * that category's own ceiling (categoryMaxPoints) — 0 for a perfect input, -ceiling for one
 * that scored 0. First shipped as a flat `(score-100)/10` for every category regardless of
 * weight, which was a real bug (docs/decisions.md, 2026-09-12): Callum reported a 90/100
 * landing whose popup showed deductions like -3.8/10 on crab (weight 10) next to -1.1/10 on
 * vertical speed (weight 25) — numbers that don't sum to anything near the actual 10-point
 * shortfall, and made a minor category look like the dominant cause. Weighting by
 * `weight/1000` makes the deductions sum to (100-overall)/10, matching what the overall
 * score actually reflects.
 */
export function deductionOutOf10(score: number, weight: number): number {
  // (score - 100), not -(100 - score): avoids returning -0 for a perfect score, which
  // fails a strict equality check even though it prints and formats identically to 0.
  return ((score - 100) * weight) / 1000
}

export function formatDeduction(score: number | null, weight: number): string {
  if (score === null) return 'N/A'
  const deduction = deductionOutOf10(score, weight)
  return deduction === 0 ? '0' : deduction.toFixed(1)
}
