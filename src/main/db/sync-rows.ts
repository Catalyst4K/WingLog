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

/** The most a peer's row time may be ahead of this computer's clock: a clock running fast, no more. A far-future time would win every conflict. */
export const MAX_PEER_TIME_AHEAD_MS = 24 * 60 * 60 * 1000

/** A UTC time as `toISOString` writes it, with 0 to 3 fractional digits (the shape the cloud accepts). */
const PEER_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/

/**
 * Checks the `updatedAt` of a row from another computer or the cloud, which is only text until it is checked (winglog-backend's
 * docs/plans/security-audit-v2.md, M2). Last write wins compares these as text, so a value that is not a real time in `toISOString`'s shape
 * can sort after every real one and make the row refuse every later edit; so can a far-future one.
 *
 * @param value The row's `updatedAt`.
 * @param now This computer's clock, in milliseconds.
 * @returns The time written as `toISOString` writes it, or null when it is not a real UTC time or is more than a day ahead of `now`.
 */
export function checkedPeerTime(value: unknown, now: number): string | null {
  if (typeof value !== 'string' || !PEER_TIME.test(value)) return null
  const time = Date.parse(value)
  if (!Number.isFinite(time) || time > now + MAX_PEER_TIME_AHEAD_MS) return null
  const normalized = new Date(time).toISOString()
  // A date that does not exist (31 February) is rolled forward by Date.parse instead of refused: the same day coming back is the check.
  return normalized.slice(0, 10) === value.slice(0, 10) ? normalized : null
}
