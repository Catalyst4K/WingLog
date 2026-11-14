/**
 * Client for the winglog-backend Cloudflare Worker (github.com/Catalyst4K/winglog-
 * backend, private repo) — the credential broker that replaced the built-in-key
 * architecture. One constant base URL, per CLAUDE.md's
 * rule for anything that shouldn't be sprinkled through the codebase. The address is
 * the project's own domain, so the Worker can move without an app update. Builds from
 * before 2026-11-09 call the Worker's old workers.dev address, which stays on until
 * they are gone (winglog-backend's docs/plans/cloud-sync-v2.md, "The custom domain").
 */
export const BACKEND_BASE_URL = 'https://api.winglog.co.uk'

export interface SimbriefSignParams {
  origIcao: string
  destIcao: string
  type: string
  timestamp: number
  outputPage: string
}

/** Calls the backend's /simbrief/sign route to get the one authorization value SimBrief's
 *  generation request needs — the key itself never leaves the backend.
 *
 * @param params The flight and timestamp the generation request will carry.
 * @returns The authorization value for SimBrief's generation request.
 * @throws When the backend refuses or can't be reached.
 */
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
