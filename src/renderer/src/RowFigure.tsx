/**
 * A list row's figure that says what it is in a narrow window and is bare in the wide table, where its column heading says it.
 *
 * The narrow layout has no column headings (winglog-backend docs/plans/v2-design.md, "Wrapping"; boards `r7-narrow-logbook` and
 * `r7-narrow-fleet-list`), so its quiet line reads "stand T4 A3 · 412.8 h · 29 flights" and "1h 37m block". The words come from the
 * locale, which also sets their order around the figure.
 */

/** Stands in for the figure while the locale's words are split around it; never shown. */
const FIGURE_MARK = '\u0000'

/**
 * Show the figure with its words below the `@3xl` container width, and bare from it up.
 *
 * @param props The figure; `words`, which returns the locale's text with the given figure in it; and an optional class for the figure
 *   alone in the narrow row (the board sets "stand" and "flights" in the sans face and only the figure in mono).
 * @returns The element.
 */
export function RowFigure(props: {
  figure: string
  words: (figure: string) => string
  figureClassName?: string
}): React.JSX.Element {
  const [before, after = ''] = props.words(FIGURE_MARK).split(FIGURE_MARK)
  return (
    <>
      <span data-layout="narrow" className="whitespace-nowrap @3xl:hidden">
        {before}
        <span className={props.figureClassName}>{props.figure}</span>
        {after}
      </span>
      <span data-layout="wide" className="hidden @3xl:inline">
        {props.figure}
      </span>
    </>
  )
}
