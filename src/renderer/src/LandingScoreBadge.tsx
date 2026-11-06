/** The landing score, as a figure. */

/**
 * Shared by Fleet's per-aircraft history and Logbook's per-flight card and list column
 * (docs/plans/landing-scoring.md) — a single place that decides how the 0-100 score looks,
 * so all three can't drift apart. `score` is null for a flight with no landing row (e.g.
 * a CSV import), rendered as "—" rather than a fabricated number. The score is a figure in the mono face; what is worth a
 * light (a firm or hard touchdown) is LandingBadge's, not a colour on the number
 * (winglog-backend docs/plans/v2-design.md).
 *
 * @param props The 0-100 score, or null.
 * @returns The element.
 */
export function LandingScoreBadge(props: { score: number | null }): React.JSX.Element {
  if (props.score === null) return <span className="text-muted-foreground">—</span>
  return <span className="font-mono">{props.score}</span>
}
