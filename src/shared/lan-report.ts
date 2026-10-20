/**
 * What a second screen may tell the PC about something it gave up on (winglog-backend's docs/plans/lan-sync.md, step 4), so the PC's log
 * shows both sides of a problem. A code from a fixed list, never free text: the page is not trusted to write to the PC's log.
 */

import { LAN_QUERY_KINDS } from './lan-queries'

/** The prefix of a report that a lookup failed, followed by the lookup's name. */
const QUERY_FAILED = 'query-failed:'

/** The reports that carry no name. */
const PLAIN_REPORTS: readonly string[] = [
  // A procedure choice made on the page that the PC never confirmed.
  'selection-unconfirmed',
  // The page has shown a flight for a while and the PC has sent no route for it.
  'route-missing'
]

/**
 * @param name A lookup's name.
 * @returns The report for a lookup the page gave up on.
 */
export function queryFailedReport(name: string): string {
  return QUERY_FAILED + name
}

/**
 * @param value What a device sent as a report.
 * @returns The code when it is one the PC knows, otherwise null.
 */
export function parseReport(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 80) return null
  if (PLAIN_REPORTS.includes(value)) return value
  if (value.startsWith(QUERY_FAILED) && Object.hasOwn(LAN_QUERY_KINDS, value.slice(QUERY_FAILED.length)))
    return value
  return null
}
