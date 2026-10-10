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
 * Free, keyless logo-by-IATA-code image service (docs/decisions.md, 2026-09-01 airline-
 * search entry) — the same service Kiwi.com's own site uses. Not every IATA code has a
 * logo there, and the service itself could go away, so a failed load swaps in a neutral
 * badge with the IATA code rather than a broken or blank icon.
 *
 * @param props The airline's IATA code, or null.
 * @returns The element, or null when there is nothing to show.
 */
export function AirlineLogo(props: { iata: string | null }): React.JSX.Element | null {
  const [failedFor, setFailedFor] = useState<string | null>(null)
  if (!props.iata) return null
  if (failedFor === props.iata) {
    return (
      <span
        data-testid="airline-logo-badge"
        aria-hidden="true"
        className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-[7px] font-semibold leading-none text-white"
        style={{ backgroundColor: `hsl(${badgeHue(props.iata)} 45% 40%)` }}
      >
        {props.iata.toUpperCase().slice(0, 3)}
      </span>
    )
  }
  return (
    <img
      src={logoSrc(BUNDLED_LOGOS, props.iata)}
      alt=""
      className="size-4 rounded-sm"
      onError={() => setFailedFor(props.iata)}
    />
  )
}
