/**
 * Client for the flightdeck-backend Cloudflare Worker (github.com/Catalyst4K/flightdeck-
 * backend, private repo) — the credential broker that replaced the built-in-key
 * architecture (docs/decisions.md, 2026-09-04). One constant base URL, per CLAUDE.md's
 * rule for anything that shouldn't be sprinkled through the codebase.
 */
export const BACKEND_BASE_URL = 'https://flightdeck-backend.callum-jones5.workers.dev'

export interface SimbriefSignParams {
  origIcao: string
  destIcao: string
  type: string
  timestamp: number
  outputPage: string
}

/** Calls the backend's /simbrief/sign route to get the one authorization value SimBrief's
 *  generation request needs — the key itself never leaves the backend. */
export async function signSimbriefRequest(params: SimbriefSignParams): Promise<string> {
  const res = await fetch(`${BACKEND_BASE_URL}/simbrief/sign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params)
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `SimBrief signing request failed (${res.status})`)
  }
  const { apicode } = (await res.json()) as { apicode: string }
  return apicode
}
