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
 * Whether data fetched at one moment predates the cycle in force at another.
 *
 * @param fetchedAtIso When the data was fetched, as an ISO time.
 * @param now The moment to judge it at.
 * @returns True when a new cycle has taken effect since the fetch. False for a time that doesn't parse.
 */
export function predatesCurrentCycle(fetchedAtIso: string, now: Date): boolean {
  const fetched = Date.parse(fetchedAtIso)
  return Number.isFinite(fetched) && fetched < airacCycleStart(now).getTime()
}
