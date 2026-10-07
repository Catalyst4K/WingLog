/**
 * Client for winglog-backend's account + sync routes (docs/plans/cloud-sync.md) —
 * mirrors backend-client.ts's shape, reusing its BACKEND_BASE_URL constant rather than
 * duplicating it (CLAUDE.md's one-constant-per-base-URL discipline).
 */
import { BACKEND_BASE_URL } from './backend-client'

/** The four tables cloud-sync.md scopes as synced — must match winglog-backend's own
 *  SYNC_TABLES exactly, since the server validates against its own copy of this list. */
export const SYNC_TABLES = ['aircraft', 'flight', 'landing', 'flightInvoice'] as const
export type SyncTable = (typeof SYNC_TABLES)[number]

export interface SyncRow {
  uuid: string
  updatedAt: string
  data: string
}

/**
 * POSTs JSON to a backend route.
 *
 * @param path The route, from the base URL.
 * @param body Sent as JSON.
 * @param headers Extra request headers.
 * @returns The response's JSON.
 * @throws The backend's own error message, or the HTTP status.
 */
async function postJson<T>(path: string, body: unknown, headers?: Record<string, string>): Promise<T> {
  const res = await fetch(`${BACKEND_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const errorBody = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(errorBody?.error ?? `Request to ${path} failed (${res.status})`)
  }
  return res.json() as Promise<T>
}

/**
 * Signs in.
 *
 * @param email The account.
 * @param password Sent once, never stored.
 * @returns The session token and when it expires.
 * @throws When the backend refuses the sign-in.
 */
export async function login(email: string, password: string): Promise<{ token: string; expiresAt: string }> {
  return postJson('/auth/login', { email, password })
}

/**
 * `POST /auth/provision`, gated behind `X-Provision-Secret` on the backend
 * (winglog-backend's src/index.ts) — there is deliberately no self-serve public signup
 * route yet (docs/plans/cloud-sync-v2.md's public-launch checklist isn't done). This is
 * that same gated route, wired up in the app rather than left CLI-only, so Callum's own
 * "Sign up" click works while the invite code stays something only he has — never baked
 * into the app itself, always typed in at the moment it's used. A wrong/missing code gets
 * the same 404 the endpoint gives anyone else, not a distinguishable error, matching the
 * route's own "don't let this be discoverable" design. Provisioning alone doesn't return a
 * session — the caller logs in right after, same as a normal signup flow anywhere else.
 *
 * @param email The new account.
 * @param password Its password.
 * @param inviteCode The provisioning secret, typed in at the time.
 * @throws When the code is wrong or the backend refuses.
 */
export async function provision(email: string, password: string, inviteCode: string): Promise<void> {
  await postJson('/auth/provision', { email, password }, { 'X-Provision-Secret': inviteCode })
}

/**
 * Ends the session on the backend.
 *
 * @param email The account.
 * @param token The session to end.
 */
export async function logout(email: string, token: string): Promise<void> {
  await postJson('/auth/logout', { email, token })
}

/**
 * Pulls one table's rows changed since the cursor.
 *
 * @param email The account.
 * @param token Its session.
 * @param table The table to pull.
 * @param since The cursor: rows changed after this ISO time, or null for all.
 * @returns The changed rows.
 */
export async function syncPull(
  email: string,
  token: string,
  table: SyncTable,
  since: string | null
): Promise<SyncRow[]> {
  const { rows } = await postJson<{ rows: SyncRow[] }>('/sync/pull', { email, token, table, since })
  return rows
}

/**
 * Pushes one table's changed rows.
 *
 * @param email The account.
 * @param token Its session.
 * @param table The table to push.
 * @param rows The local rows changed since the last push.
 * @returns The uuids the backend stored, and the ones it rejected as older than its copy.
 */
export async function syncPush(
  email: string,
  token: string,
  table: SyncTable,
  rows: SyncRow[]
): Promise<{ upserted: string[]; rejected: string[] }> {
  return postJson('/sync/push', { email, token, table, rows })
}
