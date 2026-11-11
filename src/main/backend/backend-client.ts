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

/** How long a signing call may take before it is given up, milliseconds: plan generation must not hang on a stalled connection. */
export const SIGN_TIMEOUT_MS = 30_000

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
 * @param timeoutMs How long to wait for the answer before giving up.
 * @returns The authorization value for SimBrief's generation request.
 * @throws When the backend refuses, doesn't answer in time, can't be reached, or answers with something that is not a signature.
 */
export async function signSimbriefRequest(
  params: SimbriefSignParams,
  timeoutMs = SIGN_TIMEOUT_MS
): Promise<string> {
  let res: Response
  try {
    res = await fetch(`${BACKEND_BASE_URL}/simbrief/sign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error('SimBrief signing request timed out: the backend did not answer', { cause: err })
    }
    throw err
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `SimBrief signing request failed (${res.status})`)
  }
  const answer = (await res.json().catch(() => null)) as { apicode?: unknown } | null
  if (typeof answer?.apicode !== 'string' || answer.apicode.length === 0) {
    throw new Error('SimBrief signing request failed: the backend answered with something unexpected')
  }
  return answer.apicode
}
