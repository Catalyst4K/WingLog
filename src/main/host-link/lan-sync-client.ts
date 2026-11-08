/**
 * The sync engine's client over the link to the sim PC (winglog-backend's docs/plans/multi-device.md, Part 4, and sync-cursors.md): a pull is
 * the host's pages after a counter, a push is the host's apply, so the same engine runs against the host's database as against the cloud's.
 */

import type { SyncRow, SyncTable } from '../backend/sync-client'
import type { PagedSyncClient } from '../sync/cursor-sync'
import { parseSyncVersion, type SyncVersion } from '../sync/sync-version'

/** What one push may carry: the host takes a twin's message up to 4 MB, and a push is kept well under that. */
export const PUSH_CHUNK_BYTES = 2_000_000
export const PUSH_CHUNK_ROWS = 200

/** Asks the host a lookup (`HostLink.query`). */
type Ask = (name: string, ...args: unknown[]) => Promise<unknown>

/**
 * @param value A row as the host sent it.
 * @returns The row, or null when it is not a uuid, a time and the row's data.
 */
function rowFrom(value: unknown): SyncRow | null {
  const row = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
  if (
    !row ||
    typeof row.uuid !== 'string' ||
    typeof row.updatedAt !== 'string' ||
    typeof row.data !== 'string'
  ) {
    return null
  }
  return { uuid: row.uuid, updatedAt: row.updatedAt, data: row.data }
}

/**
 * @param value The host's answer to a pull.
 * @returns Its rows, the cursor to ask from next, and whether there is more.
 * @throws When the answer is not a page.
 */
function pageFrom(value: unknown): { rows: SyncRow[]; cursor: number; more: boolean } {
  const page = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
  if (
    !page ||
    !Array.isArray(page.rows) ||
    !Number.isSafeInteger(page.cursor) ||
    (page.cursor as number) < 0 ||
    typeof page.more !== 'boolean'
  ) {
    throw new Error('The sim PC sent a page that is not rows')
  }
  const rows = page.rows.map(rowFrom)
  if (rows.some((row) => row === null)) throw new Error('The sim PC sent a row that is not a row')
  return { rows: rows as SyncRow[], cursor: page.cursor as number, more: page.more }
}

/**
 * Splits rows into pushes small enough for the host to take.
 *
 * @param rows The rows to push.
 * @returns The chunks, in order.
 */
export function chunkRows(rows: SyncRow[]): SyncRow[][] {
  const chunks: SyncRow[][] = []
  let current: SyncRow[] = []
  let bytes = 0
  for (const row of rows) {
    const size = Buffer.byteLength(row.data) + row.uuid.length + row.updatedAt.length
    if (current.length > 0 && (current.length >= PUSH_CHUNK_ROWS || bytes + size > PUSH_CHUNK_BYTES)) {
      chunks.push(current)
      current = []
      bytes = 0
    }
    current.push(row)
    bytes += size
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/** The sync client for the link to the sim PC; the account arguments of `PagedSyncClient` are not used. */
export class LanSyncClient implements PagedSyncClient {
  /** @param ask Asks the sim PC a lookup. */
  constructor(private readonly ask: Ask) {}

  /**
   * @returns The sim PC's sync protocol and database version, so a sync with a computer that speaks something else can be refused.
   * @throws When the answer is not a version.
   */
  async version(): Promise<SyncVersion> {
    const version = parseSyncVersion(await this.ask('sync.version'))
    if (!version) throw new Error('The sim PC sent an answer that is not a version')
    return version
  }

  async syncPullPage(
    _email: string,
    _token: string,
    table: SyncTable,
    cursor: number | null
  ): Promise<{ rows: SyncRow[]; cursor: number; more: boolean }> {
    return pageFrom(await this.ask('sync.pull', table, cursor))
  }

  async syncPush(
    _email: string,
    _token: string,
    table: SyncTable,
    rows: SyncRow[]
  ): Promise<{ upserted: string[]; rejected: string[] }> {
    const upserted: string[] = []
    const rejected: string[] = []
    for (const chunk of chunkRows(rows)) {
      const answer = (await this.ask('sync.push', table, chunk)) as {
        upserted?: unknown
        rejected?: unknown
      } | null
      if (!answer || !Array.isArray(answer.upserted) || !Array.isArray(answer.rejected)) {
        throw new Error('The sim PC sent an answer that is not a result')
      }
      upserted.push(...(answer.upserted as string[]))
      rejected.push(...(answer.rejected as string[]))
    }
    return { upserted, rejected }
  }
}
