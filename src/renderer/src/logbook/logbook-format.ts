/** Formatting shared by the Logbook list and a flight's detail page. */

import type { Flight, LogbookFlight } from '@shared/ipc'

export function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—'
}

/**
 * A flight actually tracked live through free-flight-tracking.md, not a dispatched one and
 * not a CSV import — neither of those two other origins is directly recorded on the row, so
 * this infers it from the two things that are: no OFP (`hasOfp` false, same as a CSV import)
 * *and* a real liftoff was recorded (`actualOffUtc` set, which a CSV import never has —
 * logbook-import.ts's createHistoricalFlight only ever supplies block-time timestamps, not
 * off/on). A free flight that never left the ground before "Finish & save" won't show the
 * badge — an acceptable miss for what's purely a display label, not something anything else
 * depends on.
 *
 * @param flight The flight.
 * @returns True if it was tracked without a SimBrief plan.
 */
export function isFreeFlight(flight: LogbookFlight | Flight): boolean {
  const hasOfp = 'hasOfp' in flight ? flight.hasOfp : flight.ofpJson != null
  return !hasOfp && flight.actualOffUtc != null
}
