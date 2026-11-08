/**
 * The rule every synced table follows (winglog-backend/docs/plans/cloud-sync.md): whether a pulled row replaces the local one. Which rows a
 * push sends is not decided here: the change counter does (sync_change, winglog-backend docs/plans/sync-cursors.md). The four tables' repos
 * (aircraft, flight, landing, flight invoice) each call this.
 */

/** A row of a synced table: its sync identity, and when it last changed. */
export interface SyncedRow {
  uuid: string | null
  updatedAt: string | null
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
