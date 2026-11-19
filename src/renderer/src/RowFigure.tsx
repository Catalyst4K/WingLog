/**
 * A list row's figure that says what it is in a narrow window and is bare in the wide table, where its column heading says it.
 *
 * The narrow layout has no column headings (winglog-backend docs/plans/v2-design.md, "Wrapping"; boards `r7-narrow-logbook` and
 * `r7-narrow-fleet-list`), so its quiet line reads "stand T4 A3 · 412.8 h · 29 flights" and "1:37 block".
 */

/**
 * Show `worded` below the `@3xl` container width and `bare` from it up.
 *
 * @param props The worded text for the narrow row (from the locale, with its no-break space), and the bare figure for the table.
 * @returns The element.
 */
export function RowFigure(props: { worded: string; bare: React.ReactNode }): React.JSX.Element {
  return (
    <>
      <span data-layout="narrow" className="whitespace-nowrap @3xl:hidden">
        {props.worded}
      </span>
      <span data-layout="wide" className="hidden @3xl:inline">
        {props.bare}
      </span>
    </>
  )
}
