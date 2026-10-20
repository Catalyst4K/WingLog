/**
 * Matches a cleared taxiway to the sim's name for it when the sim splits it into numbered pieces (winglog-backend's
 * docs/plans/beyondatc-taxi-route-highlight.md). ZUCK's facility data has no taxiway "M", only M1 to M4, while BeyondATC
 * clears "via M, G, H1": with no "M" to follow, the trace failed and the map lit up G and H1 whole, nowhere near the aircraft.
 */

import type { NavdataTaxiSegment } from '@shared/ipc'

/**
 * The network with each cleared taxiway the data has no segment for renamed from its numbered pieces ("M" from M1, M2, ...).
 * A name the data does have is never touched, and neither is a piece that is itself cleared by name ("via M1" stays M1).
 *
 * @param segments The airport's taxi network.
 * @param cleared The names the clearance uses: its taxiways and its holding point.
 * @returns The network with the pieces renamed, or `segments` itself when nothing needed it.
 */
export function aliasSplitTaxiways(segments: NavdataTaxiSegment[], cleared: string[]): NavdataTaxiSegment[] {
  const present = new Set(segments.map((s) => s.name))
  const missing = [...new Set(cleared)].filter((name) => !present.has(name))
  if (missing.length === 0) return segments
  const clearedNames = new Set(cleared)
  const aliasFor = (name: string | null): string | null =>
    name === null || clearedNames.has(name)
      ? null
      : (missing.find(
          (m) => name.length > m.length && name.startsWith(m) && /^\d+$/.test(name.slice(m.length))
        ) ?? null)
  let changed = false
  const aliased = segments.map((s) => {
    const alias = aliasFor(s.name)
    if (alias === null) return s
    changed = true
    return { ...s, name: alias }
  })
  return changed ? aliased : segments
}
