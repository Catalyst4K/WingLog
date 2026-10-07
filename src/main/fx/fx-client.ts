/**
 * USD -> display-currency exchange rate for GSX ground-service totals, via Frankfurter (frankfurter.dev): free, keyless,
 * ECB-based daily rates, no documented rate limit. Chosen over a manual rate the user enters (docs/decisions.md, 2026-09-05).
 *
 *   GET https://api.frankfurter.dev/v1/latest?base=USD&symbols=GBP
 *   { "amount": 1.0, "base": "USD", "date": "2026-09-04", "rates": { "GBP": 0.7391 } }
 *
 * An unsupported or invalid currency code returns HTTP 404 with a JSON error body, treated like any other fetch failure:
 * degrade to null (GSX totals just show in USD) rather than throw.
 *
 * `date` (YYYY-MM-DD) swaps `/latest` for `/v1/{date}` to get the rate on the day a receipt was issued, since a receipt from
 * six months ago shouldn't convert at today's rate. A non-trading day returns the most recent prior business day's rate (its
 * own `date` field says so, the same ECB "as-of" convention), and a future date 404s like an unsupported code, taking the
 * same null-fallback path.
 *
 * @param targetCurrency The ISO currency code to convert USD into.
 * @param date The receipt's day (YYYY-MM-DD), or undefined for today's rate.
 * @returns The rate, 1 for USD, or null if it couldn't be fetched.
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
