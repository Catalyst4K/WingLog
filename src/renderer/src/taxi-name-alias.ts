/**
 * Matches a cleared taxiway to the sim's name for it when the sim splits it into numbered pieces (winglog-backend's
 * docs/plans/beyondatc-taxi-route-highlight.md). ZUCK's facility data has no taxiway "M", only M1 to M4, while BeyondATC
 * clears "via M, G, H1": with no "M" to follow, the trace failed and the map lit up G and H1 whole, nowhere near the aircraft.
 */

import type { NavdataTaxiSegment } from '@shared/ipc'
import { nodeKey } from './taxi-route-trace'

/**
 * @param pieces The segments that would be renamed to one taxiway.
 * @returns Whether they all join end to end into one connected run.
 */
function isOneRun(pieces: NavdataTaxiSegment[]): boolean {
  const parent = new Map<string, string>()
  const root = (key: string): string => {
    let r = key
    while ((parent.get(r) ?? r) !== r) r = parent.get(r) ?? r
    return r
  }
  for (const s of pieces) {
    parent.set(root(nodeKey(s.startLat, s.startLon)), root(nodeKey(s.endLat, s.endLon)))
  }
  return new Set(pieces.map((s) => root(nodeKey(s.startLat, s.startLon)))).size === 1
}

/**
 * The network with each cleared taxiway the data has no segment for renamed from its numbered pieces ("M" from M1, M2, ...).
 * A name the data does have is never touched, and neither is a piece that is itself cleared by name ("via M1" stays M1). The pieces
 * must join into one run of taxiway: separate stubs that merely share a prefix are not one taxiway, and are left for the pathfinder.
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
  const isPieceOf = (name: string | null, m: string): boolean =>
    name !== null &&
    !clearedNames.has(name) &&
    name.length > m.length &&
    name.startsWith(m) &&
    /^\d+$/.test(name.slice(m.length))
  const joined = missing.filter((m) => {
    const pieces = segments.filter((s) => isPieceOf(s.name, m))
    return pieces.length > 0 && isOneRun(pieces)
  })
  const aliasFor = (name: string | null): string | null => joined.find((m) => isPieceOf(name, m)) ?? null
  let changed = false
  const aliased = segments.map((s) => {
    const alias = aliasFor(s.name)
    if (alias === null) return s
    changed = true
    return { ...s, name: alias }
  })
  return changed ? aliased : segments
}
