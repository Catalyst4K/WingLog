/**
 * How each lookup a second screen may ask of the PC is treated (winglog-backend's docs/plans/lan-sync.md, step 3). Both sides read this
 * one table, so a device cannot name its own lane: the PC and the page decide by the lookup's name.
 */

/** Which of the two sets of slots a lookup uses: quick ones answer from the PC's own data, slow ones reach the sim or the internet. */
export type LanQueryLane = 'fast' | 'slow'

interface LanQueryKind {
  lane: LanQueryLane
  /** Whether the page may keep a worthwhile answer for the length of its connection: what it asks about changes only when the PC refreshes it. */
  keep: boolean
}

const FAST = { lane: 'fast', keep: false } as const
const FAST_KEPT = { lane: 'fast', keep: true } as const
const SLOW = { lane: 'slow', keep: false } as const

/** Every lookup the PC answers. The completeness test fails if `lanQueries` (create-lan.ts) has one that is not here. */
export const LAN_QUERY_KINDS: Record<string, LanQueryKind> = {
  airfields: FAST_KEPT,
  'settings.display': FAST,
  'settings.gsxRemote': FAST,
  'settings.beyondAtc': FAST,
  // Reaches the internet.
  'weather.metars': SLOW,
  'taxi.has': FAST,
  // Fetches the whole chart from the sim, which can take minutes for a large airport.
  'taxi.refresh': SLOW,
  'taxi.get': FAST_KEPT,
  // Fetched from the sim the first time it is asked.
  stands: SLOW,
  // Fetched from the sim, about 12 seconds an airport.
  'navdata.refreshAirport': SLOW,
  'navdata.listRunways': FAST_KEPT,
  'navdata.listSids': FAST_KEPT,
  'navdata.listStars': FAST_KEPT,
  'navdata.listApproaches': FAST_KEPT,
  'navdata.procedureWaypoints': FAST_KEPT
}

/**
 * @param name A lookup's name.
 * @returns Its lane; a name not in the table is fast.
 */
export function laneOf(name: string): LanQueryLane {
  return Object.hasOwn(LAN_QUERY_KINDS, name) ? LAN_QUERY_KINDS[name].lane : 'fast'
}

/**
 * @param name A lookup's name.
 * @returns Whether the page may keep its answers.
 */
export function isKept(name: string): boolean {
  return Object.hasOwn(LAN_QUERY_KINDS, name) && LAN_QUERY_KINDS[name].keep
}

/**
 * Whether an answer is worth keeping: an empty list, nothing or false usually means "not loaded on the PC yet", and the next ask may
 * find the data there.
 *
 * @param data A lookup's answer.
 * @returns True for an answer that says something.
 */
export function isWorthKeeping(data: unknown): boolean {
  if (data === null || data === undefined || data === false) return false
  return !(Array.isArray(data) && data.length === 0)
}

/** The lookups that fetch fresh data for an airport; once one of these is answered, what the page kept about that airport is out of date. */
export const AIRPORT_REFRESH_QUERIES: readonly string[] = ['navdata.refreshAirport', 'taxi.refresh']
