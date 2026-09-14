/**
 * GSX receipt amounts are pre-formatted display text, not numbers, usually
 * `"<local> ~<USD>"` (docs/gsx-notes.md), e.g. `"£1,359.71 ~$ 1,818.96"`,
 * `"₩18,401 ~$ 13.00"`, `"RM75,246.15 ~$ 18,484.36"`. Local prefixes vary in kind (symbol,
 * multi-character code), decimal places vary by currency, and no EUR sample exists to
 * confirm whether a locale that swaps `.`/`,` would parse correctly — so arithmetic is done
 * on the USD side only (reliably `$`-prefixed, `.` decimals, `,` thousands in every sample),
 * and the local string is always displayed verbatim, never re-derived.
 *
 * A US-airport receipt (or anywhere GSX's own currency setting is already USD) has no
 * conversion to show at all — just `"$ 3,939.86"`, no `~` — confirmed live 2026-09-14 at
 * KJFK (flightdeck-backend's flight-replay-harness.md), and previously silently returned
 * null for this, hiding the invoice card's whole total whenever every receipt on a flight
 * was already-USD. Fall back to parsing the whole string as the USD amount when there's no
 * tilde, rather than treating "no conversion needed" the same as "unparseable."
 *
 * Still returns null — never throws, never guesses — for anything with no recognisable
 * `$<number>` USD amount at all, rather than risk a confidently-wrong figure.
 */
export function parseUsdAmount(text: string): number | null {
  const tildeIndex = text.indexOf('~')
  const usdPart = tildeIndex === -1 ? text : text.slice(tildeIndex + 1).trim()
  const match = /\$\s*([\d,]+(?:\.\d+)?)/.exec(usdPart)
  if (!match) return null
  const numeric = Number(match[1].replace(/,/g, ''))
  return Number.isFinite(numeric) ? numeric : null
}
