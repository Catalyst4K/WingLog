/** The landing score, as a pill tinted by how good it is. */

import { cn } from '@/lib/utils'

// Bands purely for the pill's tint, independent of the firm/hard light (LandingBadge): a score can be middling without the touchdown
// being firm or hard, and the other way about. Boundaries are a first-pass judgement call, as landing-score.ts's own constants are.
const GOOD_THRESHOLD = 80
const FAIR_THRESHOLD = 50

/**
 * Shared by Fleet's per-aircraft history and Logbook's per-flight card and list column
 * (docs/plans/landing-scoring.md) — a single place that decides how the 0-100 score looks, so all three can't drift apart. The score is a
 * figure in the mono face in a pill tinted green, amber or red by band (Callum, 2026-11-06: the plain number had lost its personality).
 * `score` is null for a flight with no landing row (e.g. a CSV import), rendered as "—" rather than a fabricated number.
 *
 * @param props The 0-100 score, or null.
 * @returns The element.
 */
export function LandingScoreBadge(props: { score: number | null }): React.JSX.Element {
  if (props.score === null) return <span className="text-muted-foreground">—</span>
  const tint =
    props.score >= GOOD_THRESHOLD
      ? 'bg-light-green/20'
      : props.score >= FAIR_THRESHOLD
        ? 'bg-light-amber/25'
        : 'bg-light-red/20'
  return (
    <span
      className={cn(
        'inline-flex min-w-9 items-center justify-center rounded-full px-2 py-0.5 font-mono text-sm text-foreground',
        tint
      )}
    >
      {props.score}
    </span>
  )
}
