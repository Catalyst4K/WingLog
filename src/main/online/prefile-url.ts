/**
 * Finds the prefile link inside a stored SimBrief OFP, checked so only the chosen network's own filing page is ever opened.
 *
 * SimBrief puts a complete filing link for each network in every OFP (`prefile.vatsim.link`, `prefile.ivao.link`). WingLog opens it as
 * given and files nothing itself: the pilot logs in and presses File on the network's own page. The link is third-party data, so it is
 * parsed once here and must be `https:`, on exactly the network's host, on its filing path, with no login or port in it.
 */
import type { OnlineNetwork } from '@shared/ipc'

/** Each network's filing page: the one host and path prefix a link must have. */
const FILING_PAGES: Record<OnlineNetwork, { host: string; pathPrefix: string }> = {
  vatsim: { host: 'my.vatsim.net', pathPrefix: '/pilots/flightplan' },
  ivao: { host: 'fpl.ivao.aero', pathPrefix: '/flight-plans/create' }
}

/**
 * @param value Anything.
 * @returns It as a network name, or null when it is not 'vatsim' or 'ivao'.
 */
export function asOnlineNetwork(value: unknown): OnlineNetwork | null {
  return value === 'vatsim' || value === 'ivao' ? value : null
}

/**
 * @param ofpJsonRaw The OFP JSON as stored on the flight, or null.
 * @param network The network to file with.
 * @returns The filing link, or null when the OFP has none or it is not on that network's own filing page.
 */
export function extractPrefileUrl(ofpJsonRaw: string | null, network: OnlineNetwork): string | null {
  if (!ofpJsonRaw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(ofpJsonRaw)
  } catch {
    return null
  }
  const prefile = field(parsed, 'prefile')
  const link = field(field(prefile, network), 'link')
  if (typeof link !== 'string') return null
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return null
  }
  const page = FILING_PAGES[network]
  const isFilingPage =
    url.protocol === 'https:' &&
    url.hostname === page.host &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    url.pathname.startsWith(page.pathPrefix)
  return isFilingPage ? url.toString() : null
}

/**
 * @param value Anything.
 * @param name A key.
 * @returns The key's value when `value` is a plain object, else undefined.
 */
function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[name]
    : undefined
}
