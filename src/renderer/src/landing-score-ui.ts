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

/** Each category's own 0-100 contribution, rescaled to a 0-to-negative-10 deduction —
 *  0 for a perfect input, -10 for one that scored 0 — per Callum's request to show "how
 *  each category affected your score" rather than a second positive number that competes
 *  with the overall 0-100 score for attention. */
export function deductionOutOf10(score: number): number {
  return (score - 100) / 10
}

export function formatDeduction(score: number | null): string {
  if (score === null) return 'N/A'
  const deduction = deductionOutOf10(score)
  return deduction === 0 ? '0' : deduction.toFixed(1)
}
