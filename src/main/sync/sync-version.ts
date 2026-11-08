/**
 * Whether two computers can sync at all (winglog-backend docs/plans/multi-device.md, D8): the sync protocol they speak, and the database
 * they keep. A twin asks the sim PC first; if they differ it does not sync, and Settings says which computer to update. The live view
 * (what the sim is doing) keeps working, because it does not depend on either.
 */

import { sql } from 'drizzle-orm'
import type { WingLogDb } from '../db/client'

/** Changes whenever what travels between two computers changes shape: version 2 is the counted cursors and the compressed OFP. */
export const SYNC_PROTOCOL_VERSION = 2

/** What one computer reports of itself. */
export interface SyncVersion {
  protocol: number
  /** How many migrations its database has applied: two builds with the same number have the same tables. */
  schema: number
}

/** What a twin does about the sim PC's version. */
export type VersionVerdict = 'same' | 'update-this-computer' | 'update-sim-pc'

/**
 * @param db The database.
 * @returns This computer's protocol and database version.
 */
export function localSyncVersion(db: WingLogDb): SyncVersion {
  const row = db.get<{ n: number }>(sql`SELECT count(*) AS n FROM __drizzle_migrations`)
  return { protocol: SYNC_PROTOCOL_VERSION, schema: row.n }
}

/**
 * @param value The sim PC's answer to `sync.version`.
 * @returns The version, or null when the answer is not one.
 */
export function parseSyncVersion(value: unknown): SyncVersion | null {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
  if (!record || !Number.isSafeInteger(record.protocol) || !Number.isSafeInteger(record.schema)) return null
  return { protocol: record.protocol as number, schema: record.schema as number }
}

/**
 * @param here This computer's version.
 * @param host The sim PC's version.
 * @returns Whether they can sync, and if not which computer is behind (the one with the lower number).
 */
export function compareSyncVersions(here: SyncVersion, host: SyncVersion): VersionVerdict {
  if (here.protocol === host.protocol && here.schema === host.schema) return 'same'
  const hereIsBehind =
    here.protocol !== host.protocol ? here.protocol < host.protocol : here.schema < host.schema
  return hereIsBehind ? 'update-this-computer' : 'update-sim-pc'
}
