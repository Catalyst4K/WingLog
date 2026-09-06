/**
 * USD -> display-currency exchange rate for GSX ground-service totals, via Frankfurter
 * (frankfurter.dev) — free, keyless, ECB-based daily rates, no documented rate limit.
 * Chosen over a manual rate the user enters themselves per Callum's 2026-09-05 request
 * for a live rate (docs/decisions.md). Verified against real live responses, not just
 * its docs:
 *
 *   GET https://api.frankfurter.dev/v1/latest?base=USD&symbols=GBP
 *   { "amount": 1.0, "base": "USD", "date": "2026-09-04", "rates": { "GBP": 0.7391 } }
 *
 * An unsupported/invalid currency code returns HTTP 404 with a JSON error body (verified
 * against a made-up code) — treated the same as any other fetch failure below: degrade to
 * null (GSX totals just show in USD, same as today) rather than throwing.
 *
 * `date` (YYYY-MM-DD) swaps `/latest` for `/v1/{date}` to get the rate that actually
 * applied on the day a receipt was issued, rather than today's rate — a receipt from
 * six months ago shouldn't be converted at today's exchange rate. Also verified live:
 * a non-trading day (weekend/holiday) returns the most recent prior business day's rate
 * (its own `date` field reflects that, same ECB "as-of" convention `/latest` already
 * uses), and a future date 404s exactly like an unsupported currency code — same
 * null-fallback path, nothing GSX-specific to handle there.
 */
export async function fetchExchangeRate(targetCurrency: string, date?: string): Promise<number | null> {
  const code = targetCurrency.trim().toUpperCase()
  if (code === '' || code === 'USD') return 1

  try {
    const path = date ? date : 'latest'
    const url = `https://api.frankfurter.dev/v1/${encodeURIComponent(path)}?base=USD&symbols=${encodeURIComponent(code)}`
    const response = await fetch(url)
    if (!response.ok) return null

    const raw: unknown = await response.json().catch(() => undefined)
    if (typeof raw !== 'object' || raw === null) return null
    const rates = (raw as { rates?: unknown }).rates
    if (typeof rates !== 'object' || rates === null) return null

    const rate = (rates as Record<string, unknown>)[code]
    return typeof rate === 'number' && Number.isFinite(rate) ? rate : null
  } catch {
    return null
  }
}
