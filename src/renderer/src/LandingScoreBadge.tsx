import { Badge } from '@/components/ui/badge'

// Bands purely for the badge's colour, independent of the firm/hard classification
// (LandingBadge) — a score can be middling without the touchdown itself being firm/hard,
// and vice versa (e.g. a firm touchdown dead on the centreline and aiming point still
// scores reasonably). Boundaries are a first-pass judgement call, same honesty register as
// landing-score.ts's own constants.
const GOOD_THRESHOLD = 80
const FAIR_THRESHOLD = 50

/** Shared by Fleet's per-aircraft history and Logbook's per-flight card and list column
 *  (docs/plans/landing-scoring.md) — a single place that decides how the 0-100 score looks,
 *  so all three can't drift apart. `score` is null for a flight with no landing row (e.g.
 *  a CSV import), rendered as "—" rather than a fabricated number. */
export function LandingScoreBadge(props: { score: number | null }): React.JSX.Element {
  if (props.score === null) return <span className="text-muted-foreground">—</span>
  const variant = props.score >= GOOD_THRESHOLD ? 'default' : props.score >= FAIR_THRESHOLD ? 'secondary' : 'destructive'
  return <Badge variant={variant}>{props.score}</Badge>
}
