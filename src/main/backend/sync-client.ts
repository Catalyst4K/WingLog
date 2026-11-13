/**
 * Client for winglog-backend's account + sync routes (docs/plans/cloud-sync.md) —
 * mirrors backend-client.ts's shape, reusing its BACKEND_BASE_URL constant rather than
 * duplicating it (CLAUDE.md's one-constant-per-base-URL discipline).
 */
import { BACKEND_BASE_URL } from './backend-client'
import { BackendError } from './backend-error'
import type { KnownCounter } from '../sync/cursor-sync'

/** Every table WingLog syncs between its own computers: the four of cloud-sync.md, and the GSX routines (docs/plans/gsx-routines-sync.md). */
export const SYNC_TABLES = ['aircraft', 'flight', 'landing', 'flightInvoice', 'gsxRoutine'] as const
export type SyncTable = (typeof SYNC_TABLES)[number]

/** The tables the Worker accepts — must match winglog-backend's own SYNC_TABLES exactly, since the server validates against its own copy of
 *  this list. The Worker must be deployed with the GSX routines table (winglog-backend 2026-11-09) before a build with this list is used. */
export const CLOUD_SYNC_TABLES: readonly SyncTable[] = SYNC_TABLES

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
 * @param timeoutMs How long to wait for the whole call before giving up, so a stalled connection cannot hold a sync open for ever.
 * @returns The response's JSON.
 * @throws A `BackendError` carrying the HTTP status, with the backend's own error message or one that names the status.
 */
async function postJson<T>(
  path: string,
  body: unknown,
  headers?: Record<string, string>,
  timeoutMs = 30_000
): Promise<T> {
  const res = await fetch(`${BACKEND_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!res.ok) {
    const errorBody = (await res.json().catch(() => null)) as { error?: string } | null
    throw new BackendError(errorBody?.error ?? `Request to ${path} failed (${res.status})`, res.status)
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
 * `POST /auth/delete`: deletes the account on the backend, and everything stored in it, for the right password.
 *
 * @param email The account.
 * @param password The account's password, sent once and never stored.
 * @throws When the backend refuses (a wrong password).
 */
export async function deleteAccount(email: string, password: string): Promise<void> {
  await postJson('/auth/delete', { email, password })
}

/**
 * `POST /auth/forgot`: asks the service to email a reset code to the account's address. It answers the same whether or not there is such an
 * account.
 *
 * @param email The address the account was made with.
 * @throws When the service refuses (too many requests, or password reset is not switched on yet: it answers "not found").
 */
export async function forgotPassword(email: string): Promise<void> {
  await postJson('/auth/forgot', { email })
}

/**
 * `POST /auth/reset`: sets a new password for the code that was emailed. Every device is signed out afterwards.
 *
 * @param email The account.
 * @param code The code from the email.
 * @param password The new password, sent once and never stored.
 * @throws When the code is wrong, used or out of date.
 */
export async function resetPassword(email: string, code: string, password: string): Promise<void> {
  await postJson('/auth/reset', { email, code, password })
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
 * One page of a pull: the rows, the cursor to ask from next, and whether there is a further page. `head` is the Worker's highest change number and
 * `epoch` names its counter's present run of numbers (review of M8); an older Worker sends neither.
 */
export interface SyncPage {
  rows: SyncRow[]
  cursor: number
  more: boolean
  head?: number
  epoch?: string
}

/** The longest epoch taken: the Worker's are UUIDs. */
const MAX_EPOCH_CHARS = 64

/**
 * @param value A counter the backend may leave out.
 * @returns True when it is left out or a whole number from zero.
 */
function isOptionalCounter(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) >= 0)
}

/**
 * @param value An epoch the backend may leave out.
 * @returns True when it is left out or a short, non-empty text.
 */
export function isOptionalEpoch(value: unknown): boolean {
  return (
    value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= MAX_EPOCH_CHARS)
  )
}

/** A sync call carries up to 20 MB, so it gets longer than an account call, but not for ever (audit L6). */
const SYNC_TIMEOUT_MS = 120_000

const BAD_ANSWER = 'The backend answered with something unexpected.'

/**
 * @param value Something the backend sent.
 * @returns True when it is a list of text.
 */
function isTextList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/**
 * Pulls one page of a table's rows after the cursor, in the order the backend wrote them, so no row is skipped whatever its time.
 *
 * @param email The account.
 * @param token Its session.
 * @param table The table to pull.
 * @param cursor The `cursor` of the last page for this table, or null for everything.
 * @param known What this computer knows of the Worker's counter, so the Worker can tell when it went back (review of M8).
 * @returns The page.
 * @throws When the backend refuses, or answers with something that is not a page.
 */
export async function syncPullPage(
  email: string,
  token: string,
  table: SyncTable,
  cursor: number | null,
  known: KnownCounter = { seen: null, epoch: null }
): Promise<SyncPage> {
  const page = await postJson<Partial<SyncPage>>(
    '/sync/pull',
    { email, token, table, cursor, seen: known.seen, epoch: known.epoch },
    undefined,
    SYNC_TIMEOUT_MS
  )
  const rowsOk =
    Array.isArray(page.rows) &&
    page.rows.every(
      (row) =>
        typeof row === 'object' &&
        row !== null &&
        typeof row.uuid === 'string' &&
        typeof row.updatedAt === 'string' &&
        typeof row.data === 'string'
    )
  if (
    !rowsOk ||
    !Number.isSafeInteger(page.cursor) ||
    (page.cursor as number) < 0 ||
    typeof page.more !== 'boolean' ||
    !isOptionalCounter(page.head) ||
    !isOptionalEpoch(page.epoch)
  ) {
    throw new Error(BAD_ANSWER)
  }
  return {
    rows: page.rows as SyncRow[],
    cursor: page.cursor as number,
    more: page.more,
    ...(page.head === undefined ? {} : { head: page.head }),
    ...(page.epoch === undefined ? {} : { epoch: page.epoch })
  }
}

/**
 * Pushes one table's changed rows.
 *
 * @param email The account.
 * @param token Its session.
 * @param table The table to push.
 * @param rows The local rows changed since the last push.
 * @returns The uuids the backend stored, the ones it rejected as older than its copy, and the ones it refused as not valid.
 * @throws When the backend refuses, or answers with something that is not a result.
 */
export async function syncPush(
  email: string,
  token: string,
  table: SyncTable,
  rows: SyncRow[]
): Promise<{ upserted: string[]; rejected: string[]; refused: string[]; head?: number }> {
  const result = await postJson<{
    upserted?: unknown
    rejected?: unknown
    refused?: unknown
    head?: unknown
  }>('/sync/push', { email, token, table, rows }, undefined, SYNC_TIMEOUT_MS)
  // An older Worker sends neither `refused` (the same as none) nor `head`.
  const refused = result.refused === undefined ? [] : result.refused
  if (
    !isTextList(result.upserted) ||
    !isTextList(result.rejected) ||
    !isTextList(refused) ||
    !isOptionalCounter(result.head)
  ) {
    throw new Error(BAD_ANSWER)
  }
  return {
    upserted: result.upserted,
    rejected: result.rejected,
    refused,
    ...(result.head === undefined ? {} : { head: result.head as number })
  }
}
