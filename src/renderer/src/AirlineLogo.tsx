/** An airline's logo, by IATA code. */

/**
 * Free, keyless logo-by-IATA-code image service (docs/decisions.md, 2026-09-01 airline-
 * search entry) — the same service Kiwi.com's own site uses. Not every IATA code has a
 * logo there, so a failed load just hides the image rather than showing a broken icon.
 *
 * @param props The airline's IATA code, or null.
 * @returns The element, or null when there is nothing to show.
 */
export function AirlineLogo(props: { iata: string | null }): React.JSX.Element | null {
  if (!props.iata) return null
  return (
    <img
      src={`https://images.kiwi.com/airlines/32/${props.iata}.png`}
      alt=""
      className="size-4 rounded-sm"
      onError={(e) => {
        e.currentTarget.style.display = 'none'
      }}
    />
  )
}
