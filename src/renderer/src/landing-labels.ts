/** Labels for a flight's landings: the airport and which attempt there it was. */

import { displayIcao } from './display-icao'

/**
 * Not yet translated — a pure exported function with its own unit tests asserting exact
 * English output, same deliberate gap as flight-label.ts's "this flight"/"flight from X"
 * (docs/plans/v1-2.md Part 3). displayIcao's own "Unknown" fallback (for ZZZZ) is the same
 * kind of gap, already shipped untranslated across Fleet/Dispatch/Track.
 *
 * @param landings The flight's landings, in order.
 * @returns A label for each, e.g. "VHHH 1", "VHHH 2".
 */
export function landingLabels(landings: { icao: string | null }[]): string[] {
  const attempts = new Map<string, number>()
  return landings.map((l, index) => {
    if (!l.icao) return `Landing ${index + 1}`
    const attempt = (attempts.get(l.icao) ?? 0) + 1
    attempts.set(l.icao, attempt)
    return `${displayIcao(l.icao)} ${attempt}`
  })
}
