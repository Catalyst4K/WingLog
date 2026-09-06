/**
 * Client for flightdeck-backend's account + sync routes (docs/plans/cloud-sync.md) —
 * mirrors backend-client.ts's shape, reusing its BACKEND_BASE_URL constant rather than
 * duplicating it (CLAUDE.md's one-constant-per-base-URL discipline).
 */
import { BACKEND_BASE_URL } from './backend-client'

/** The four tables cloud-sync.md scopes as synced — must match flightdeck-backend's own
 *  SYNC_TABLES exactly, since the server validates against its own copy of this list. */
export const SYNC_TABLES = ['aircraft', 'flight', 'landing', 'flightInvoice'] as const
export type SyncTable = (typeof SYNC_TABLES)[number]

export interface SyncRow {
  uuid: string
  updatedAt: string
  data: string
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BACKEND_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const errorBody = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(errorBody?.error ?? `Request to ${path} failed (${res.status})`)
  }
  return res.json() as Promise<T>
}

export async function login(email: string, password: string): Promise<{ token: string; expiresAt: string }> {
  return postJson('/auth/login', { email, password })
}

export async function logout(email: string, token: string): Promise<void> {
  await postJson('/auth/logout', { email, token })
}

export async function syncPull(
  email: string,
  token: string,
  table: SyncTable,
  since: string | null
): Promise<SyncRow[]> {
  const { rows } = await postJson<{ rows: SyncRow[] }>('/sync/pull', { email, token, table, since })
  return rows
}

export async function syncPush(
  email: string,
  token: string,
  table: SyncTable,
  rows: SyncRow[]
): Promise<{ upserted: string[]; rejected: string[] }> {
  return postJson('/sync/push', { email, token, table, rows })
}
