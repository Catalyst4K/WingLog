/** An airline's logo, by IATA code. */

import { useState } from 'react'
import { badgeHue, logoSrc } from './airline-logo-src'

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
 * Free, keyless logo-by-IATA-code image service (docs/decisions.md airline-
 * search entry) — the same service Kiwi.com's own site uses. Not every IATA code has a
 * logo there, and the service itself could go away, so a failed load swaps in a neutral
 * badge with the IATA code rather than a broken or blank icon.
 *
 * @param props The airline's IATA code, or null, and the logo's size in pixels (16 by default; a headline's is about 30).
 * @returns The element, or null when there is nothing to show.
 */
export function AirlineLogo(props: { iata: string | null; size?: number }): React.JSX.Element | null {
  const size = props.size ?? 16
  const [failedFor, setFailedFor] = useState<string | null>(null)
  if (!props.iata) return null
  if (failedFor === props.iata) {
    return (
      <span
        data-testid="airline-logo-badge"
        aria-hidden="true"
        className="inline-flex shrink-0 items-center justify-center rounded-sm font-semibold leading-none text-white"
        style={{
          width: size,
          height: size,
          fontSize: Math.max(7, Math.round(size * 0.4)),
          backgroundColor: `hsl(${badgeHue(props.iata)} 45% 40%)`
        }}
      >
        {props.iata.toUpperCase().slice(0, 3)}
      </span>
    )
  }
  return (
    <img
      src={logoSrc(BUNDLED_LOGOS, props.iata)}
      alt=""
      className="shrink-0 rounded-sm"
      style={{ width: size, height: size }}
      onError={() => setFailedFor(props.iata)}
    />
  )
}
