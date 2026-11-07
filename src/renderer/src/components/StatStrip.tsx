/** Rows of figures between hairlines or in a box: a Logbook flight's summary strip and the figures of a Fleet aircraft. */

/**
 * One cell of a strip: a quiet label over a figure in the mono face, and, when there is one, the plan's figure under it in magenta.
 *
 * @param props The label, the figure, and the plan's figure.
 * @returns The element.
 */
export function StatCell(props: {
  label: string
  children: React.ReactNode
  plan?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-w-36 flex-1 flex-col border-r border-border px-4 py-2.5 last:border-r-0">
      <dt className="text-[13px] text-muted-foreground">{props.label}</dt>
      <dd className="m-0 mt-0.5 min-w-0 font-mono text-xl break-words text-foreground">{props.children}</dd>
      {props.plan !== undefined && props.plan !== null && (
        <dd className="m-0 font-mono text-[13px] text-muted-foreground">{props.plan}</dd>
      )}
    </div>
  )
}

/**
 * The strip itself (winglog-backend docs/plans/v2-design.md and the canvas's r3-flight): a thin box in the text colour with a cell for each
 * figure, wrapping onto a second line in a narrow window, with no empty cell left over.
 *
 * @param props The cells.
 * @returns The element.
 */
export function StatStrip(props: { children: React.ReactNode }): React.JSX.Element {
  return <dl className="m-0 flex flex-wrap rounded-[2px] border border-foreground">{props.children}</dl>
}
