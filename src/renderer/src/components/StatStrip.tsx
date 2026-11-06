/** A boxed row of figures divided by hairlines: the summary strip of a Logbook flight and of a Fleet aircraft. */

/**
 * One cell of a strip: a quiet label over a figure in the mono face.
 *
 * @param props The label and what goes under it.
 * @returns The element.
 */
export function StatCell(props: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex min-w-36 flex-1 flex-col gap-0.5 border-l border-border px-3 py-2 first:border-l-0">
      <dt className="text-xs text-muted-foreground">{props.label}</dt>
      <dd className="min-w-0 font-mono text-sm break-words text-foreground">{props.children}</dd>
    </div>
  )
}

/**
 * The strip itself: cells side by side, wrapping onto a second line in a narrow window, with no empty cell left over.
 *
 * @param props The cells.
 * @returns The element.
 */
export function StatStrip(props: { children: React.ReactNode }): React.JSX.Element {
  return <dl className="flex flex-wrap overflow-hidden rounded-md bg-card">{props.children}</dl>
}
