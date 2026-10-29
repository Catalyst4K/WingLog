/**
 * The AIRAC cycle: navigation data worldwide changes on a fixed 28-day schedule (ICAO Annex 15), so the
 * date alone says when cached navdata has gone out of date. No Navigraph or network lookup is needed.
 */

/** The effective date of AIRAC 2501, the first cycle of 2025. Every cycle is a whole number of 28-day steps from it. */
const AIRAC_REFERENCE_MS = Date.UTC(2025, 0, 23)
const AIRAC_CYCLE_MS = 28 * 24 * 60 * 60 * 1000

/**
 * The start of the AIRAC cycle in force at a moment.
 *
 * @param at The moment.
 * @returns The cycle's effective date, 00:00 UTC.
 */
export function airacCycleStart(at: Date): Date {
  const cycles = Math.floor((at.getTime() - AIRAC_REFERENCE_MS) / AIRAC_CYCLE_MS)
  return new Date(AIRAC_REFERENCE_MS + cycles * AIRAC_CYCLE_MS)
}

/**
 * The AIRAC cycle's number as the data providers write it: the year's last two digits, then the cycle's place in that year (2611 is the
 * eleventh cycle of 2026). A year's cycles are counted from the first to take effect in it.
 *
 * @param at The moment.
 * @returns The cycle in force at that moment, such as "2611".
 */
export function airacCycleNumber(at: Date): string {
  const start = airacCycleStart(at)
  const year = start.getUTCFullYear()
  const place = Math.floor((start.getTime() - Date.UTC(year, 0, 1)) / AIRAC_CYCLE_MS) + 1
  return `${String(year % 100).padStart(2, '0')}${String(place).padStart(2, '0')}`
}

/**
 * Whether data fetched at one moment predates a cutoff.
 *
 * @param fetchedAtIso When the data was fetched, as an ISO time.
 * @param cutoffMs The moment it had to be fetched after.
 * @returns True when it was fetched before the cutoff. False for a time that doesn't parse.
 */
export function fetchedBefore(fetchedAtIso: string, cutoffMs: number): boolean {
  const fetched = Date.parse(fetchedAtIso)
  return Number.isFinite(fetched) && fetched < cutoffMs
}

/**
 * Whether data fetched at one moment predates the cycle in force at another.
 *
 * @param fetchedAtIso When the data was fetched, as an ISO time.
 * @param now The moment to judge it at.
 * @returns True when a new cycle has taken effect since the fetch. False for a time that doesn't parse.
 */
export function predatesCurrentCycle(fetchedAtIso: string, now: Date): boolean {
  return fetchedBefore(fetchedAtIso, airacCycleStart(now).getTime())
}
