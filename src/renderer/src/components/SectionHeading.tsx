/** A section's opener: a 3 px ink rule, the title in Golos, and something quiet on the right where there is something to say. */

/**
 * Opens every section and panel (winglog-backend docs/plans/v2-design.md, "The design rules", Round 7): the bold title on the left, a
 * quiet count or source (or a control) on the right, the whole under a 3 px rule in the text colour.
 *
 * @param props The title, what sits on the right of it, and the heading's level (2 by default).
 * @returns The element.
 */
export function SectionHeading(props: {
  title: React.ReactNode
  aside?: React.ReactNode
  level?: 2 | 3
  className?: string
}): React.JSX.Element {
  const Heading = props.level === 3 ? 'h3' : 'h2'
  return (
    <div
      className={`flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t-[3px] border-foreground pt-2 pb-1.5 ${props.className ?? ''}`}
    >
      <Heading className="m-0 font-display text-[17px] leading-snug font-bold tracking-[-0.01em]">
        {props.title}
      </Heading>
      {props.aside && (
        <span className="flex items-center gap-2 text-[13px] text-muted-foreground">{props.aside}</span>
      )}
    </div>
  )
}
