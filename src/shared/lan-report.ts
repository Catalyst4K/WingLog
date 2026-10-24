/**
 * What a second screen may tell the PC (winglog-backend's docs/plans/lan-sync.md, step 4, and docs/plans/taxi-and-second-screen-robustness.md,
 * stage 5), so the PC's log shows both sides of a problem: what the page gave up on, and that it is hearing what the PC pushes. A code from
 * a fixed list, never free text: the page is not trusted to write to the PC's log. A few codes carry a short detail, checked here too.
 */

import { LAN_QUERY_KINDS } from './lan-queries'

/** The prefix of a report that a lookup failed, followed by the lookup's name. */
const QUERY_FAILED = 'query-failed:'

/** The reports that carry no name. */
const PLAIN_REPORTS: readonly string[] = [
  // A procedure choice made on the page that the PC never confirmed.
  'selection-unconfirmed',
  // The page has shown a flight for a while and the PC has sent no route for it.
  'route-missing',
  // The link to the PC came back after it had been down: the log shows when a locked or roaming phone rejoined.
  'reconnected',
  // The page has taken a planned route, or a taxi line, the PC pushed (detail: its revision), so a line that never appeared on the phone
  // can be told apart from one the phone never heard.
  'route-applied',
  'taxi-route-applied',
  // Script on the page threw, or a promise on it was rejected and nobody was listening (detail: the message, never a stack).
  'script-error'
]

/** The longest detail written to the log, in characters. */
export const MAX_REPORT_DETAIL = 300

/** What each code that carries a detail accepts. */
const DETAILS: Record<string, (detail: string) => string | null> = {
  'route-applied': revision,
  'taxi-route-applied': revision,
  'script-error': message
}

/**
 * @param detail What a device sent.
 * @returns The detail when it is a revision ("r12"), otherwise null.
 */
function revision(detail: string): string | null {
  return /^r\d{1,9}$/.test(detail) ? detail : null
}

/**
 * @param detail What a device sent.
 * @returns The detail as one line of text: control characters (newlines, which could fake another log line, among them) become spaces, runs of
 *   spaces become one, and it is cut at MAX_REPORT_DETAIL; null when nothing is left.
 */
function message(detail: string): string | null {
  // Control characters (a newline could fake another log line), and the Unicode line and paragraph separators, become spaces.
  let line = ''
  for (const char of detail) {
    const code = char.codePointAt(0) ?? 0
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029
    line += control ? ' ' : char
  }
  const text = line.replace(/ {2,}/g, ' ').trim().slice(0, MAX_REPORT_DETAIL)
  return text.length > 0 ? text : null
}

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

/**
 * @param code A report code the PC knows (parseReport's answer).
 * @param value What the device sent with it.
 * @returns The detail to log with the code, or null when the code takes none, the device sent none, or what it sent is not acceptable.
 */
export function parseReportDetail(code: string, value: unknown): string | null {
  if (typeof value !== 'string' || !Object.hasOwn(DETAILS, code)) return null
  // Cut before the check, so a huge string is never walked: the longest message kept is MAX_REPORT_DETAIL.
  return DETAILS[code](value.slice(0, MAX_REPORT_DETAIL * 4))
}
