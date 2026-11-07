/** The plan's mark: text that is the plan (the chosen procedures, the route) stays in the text colour, with a short magenta rule before it. */

/**
 * Plan text with its rule. The plan's colour is for what is drawn (the route on the map, the profile, the fuel bar), never for text on a
 * page (winglog-backend docs/plans/v2-design.md, "The design rules"); a rule at the left marks the text as the plan instead.
 *
 * @param props The text, and extra classes for it.
 * @returns The element.
 */
export function PlanMark(props: { children: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <span className="inline-flex min-w-0 items-center gap-2" data-testid="plan-mark">
      <span aria-hidden="true" className="h-[18px] w-[3px] shrink-0 rounded-[1px] bg-plan" />
      <span className={props.className ?? 'font-mono text-[15px]'}>{props.children}</span>
    </span>
  )
}
