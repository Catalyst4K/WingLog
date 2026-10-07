/**
 * The two rules every synced table follows (winglog-backend/docs/plans/cloud-sync.md): which local
 * rows a push sends, and whether a pulled row replaces the local one. The four tables' repos
 * (aircraft, flight, landing, flight invoice) each keep their own typed query and call these.
 */

/** A row of a synced table: its sync identity, and when it last changed. */
export interface SyncedRow {
  uuid: string | null
  updatedAt: string | null
}

/**
 * The rows a push sends: those with a sync identity (every row written by this app version; see
 * schema.ts's aircraft.uuid comment) that changed after `since`, oldest first.
 *
 * @param rows Every row of the table.
 * @param since The table's sync cursor, or null for "never synced", meaning every row.
 * @returns The rows to push.
 */
export function rowsChangedSince<R extends SyncedRow>(rows: R[], since: string | null): R[] {
  return rows
    .filter((row) => row.uuid !== null && row.updatedAt !== null && (since === null || row.updatedAt > since))
    .sort((a, b) => (a.updatedAt as string).localeCompare(b.updatedAt as string))
}

/**
 * Whether a pulled row replaces the local row with the same uuid. Last write wins against a local
 * edit too, not just the server's copy: a local row changed at the same time or later is kept, as
 * winglog-backend's UserStore.push does. Without this, whichever device ran "Sync now" second
 * lost its own newer edit, silently.
 *
 * @param existing The local row with that uuid, if any.
 * @param incomingUpdatedAt The pulled row's updatedAt.
 * @returns True to apply the pulled row.
 */
export function shouldApplyPulledRow(existing: SyncedRow | undefined, incomingUpdatedAt: unknown): boolean {
  if (!existing || existing.updatedAt === null || typeof incomingUpdatedAt !== 'string') return true
  return existing.updatedAt < incomingUpdatedAt
}
