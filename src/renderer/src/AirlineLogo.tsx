/** An airline's logo, by IATA code. */

import { logoSrc } from './airline-logo-src'

/**
 * Logos bundled with the app (airline-logos/<IATA>.png), which win over the image service
 * for codes where the service's logo is out of date (e.g. KA, Cathay Dragon).
 */
const BUNDLED_LOGOS = import.meta.glob('./airline-logos/*.png', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>

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
      src={logoSrc(BUNDLED_LOGOS, props.iata)}
      alt=""
      className="size-4 rounded-sm"
      onError={(e) => {
        e.currentTarget.style.display = 'none'
      }}
    />
  )
}
