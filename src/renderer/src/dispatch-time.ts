/** Dispatch's departure time: its default, the datetime input's value, and SimBrief's format. */

import type { DispatchDeparture } from '@shared/ipc'

const FIVE_MINUTES_MS = 5 * 60 * 1000
const FORTY_FIVE_MINUTES_MS = 45 * 60 * 1000
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000

/**
 * Default departure time for a freshly-selected aircraft on Dispatch's "Plan a flight"
 * card: now + 45 minutes, rounded up to the next 5 minutes so it reads like a real
 * schedule rather than an arbitrary "18:23". All arithmetic is on the Date's own epoch
 * milliseconds, so it's timezone-agnostic by construction — no UTC/local getter is
 * involved until toSimBriefDeparture below reads one back out.
 *
 * @param now The current time.
 * @returns The default departure time.
 */
export function defaultDepartureTime(now: Date): Date {
  const target = now.getTime() + FORTY_FIVE_MINUTES_MS
  return new Date(Math.ceil(target / FIVE_MINUTES_MS) * FIVE_MINUTES_MS)
}

/**
 * Converts a departure Date into the shape SimBrief's prefill URL wants
 * (docs/simbrief-notes.md, 2026-09-02 spike): `date` is midnight UTC of the departure
 * day in epoch seconds, `hour`/`minute` are the plain UTC time. Uses UTC getters
 * throughout — the local-time getters are the easy mistake here, since a departure
 * "23:58 UTC" must roll the date forward in UTC, not in whatever timezone this process
 * happens to run in.
 *
 * Returns null for anything wildly out of range (SimBrief silently misreads a
 * wrong-format date as a 1970 departure rather than rejecting it, so this is checked
 * here rather than trusted) — the caller should omit the date/deph/depm parameters
 * entirely rather than send a nonsense value.
 *
 * @param date The departure time.
 * @returns SimBrief's date, hour and minute, or null if out of range.
 */
export function toSimBriefDeparture(date: Date): DispatchDeparture | null {
  if (Number.isNaN(date.getTime())) return null
  if (Math.abs(date.getTime() - Date.now()) > ONE_YEAR_MS) return null

  const midnightUtc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  return {
    dateEpochSeconds: Math.floor(midnightUtc / 1000),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes()
  }
}

/**
 * For a `<input type="datetime-local">` bound to a UTC Date — the input has no timezone
 * of its own, so its value is treated as the UTC wall-clock time directly, never the
 * system's local timezone (the field is labelled "UTC/Z" in the UI to match).
 *
 * @param date The time.
 * @returns The input's value, "YYYY-MM-DDTHH:MM" in UTC.
 */
export function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
  )
}

/**
 * Inverse of toDatetimeLocalValue — null for an empty/invalid input rather than an Invalid Date.
 *
 * @param value The input's value.
 * @returns The time, or null.
 */
export function fromDatetimeLocalValue(value: string): Date | null {
  if (!value) return null
  const date = new Date(`${value}:00Z`)
  return Number.isNaN(date.getTime()) ? null : date
}
