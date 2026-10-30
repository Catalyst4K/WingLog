/**
 * Where the network feeds are, and how WingLog identifies itself to them. The one module that holds these addresses (always `https:`),
 * like the backend's base URL. A feed address found in third-party data is checked before it is used.
 */

/** Where VATSIM lists its current data addresses. */
export const VATSIM_STATUS_URL = 'https://status.vatsim.net/status.json'
/** VATSIM's data feed, used when the status page cannot be read or names something unexpected. */
export const VATSIM_DATA_URL = 'https://data.vatsim.net/v3/vatsim-data.json'
/** IVAO's Whazzup feed. */
export const IVAO_WHAZZUP_URL = 'https://api.ivao.aero/v2/tracker/whazzup'

/** The host a VATSIM data address must be on. */
const VATSIM_DATA_HOST = 'data.vatsim.net'

/** Where the feeds are read from; the fields are replaced only by the test overrides below. */
export interface FeedUrls {
  /** VATSIM's status page, read once per session; null skips it and uses `vatsimData` as it is. */
  vatsimStatus: string | null
  vatsimData: string
  ivao: string
}

/** The real addresses. */
export const REAL_FEED_URLS: FeedUrls = {
  vatsimStatus: VATSIM_STATUS_URL,
  vatsimData: VATSIM_DATA_URL,
  ivao: IVAO_WHAZZUP_URL
}

/**
 * Finds VATSIM's current data address in its status page.
 *
 * @param status The status page's JSON, already parsed, or anything at all.
 * @returns `data.v3[0]` when it is an `https:` address on data.vatsim.net, else null.
 */
export function vatsimDataUrl(status: unknown): string | null {
  if (typeof status !== 'object' || status === null) return null
  const data: unknown = (status as { data?: unknown }).data
  const v3: unknown = typeof data === 'object' && data !== null ? (data as { v3?: unknown }).v3 : undefined
  const first: unknown = Array.isArray(v3) ? v3[0] : undefined
  if (typeof first !== 'string') return null
  try {
    const url = new URL(first)
    return url.protocol === 'https:' && url.hostname === VATSIM_DATA_HOST && !url.username && !url.password
      ? url.toString()
      : null
  } catch {
    return null
  }
}

/**
 * The User-Agent every feed request sends.
 *
 * @param version The app's version.
 * @returns "WingLog/1.6.0 (+https://github.com/Catalyst4K/WingLog)".
 */
export function feedUserAgent(version: string): string {
  return `WingLog/${version} (+https://github.com/Catalyst4K/WingLog)`
}

/**
 * The feed addresses, with the end-to-end test overrides honoured only in an unpackaged app (as `WINGLOG_UPDATE_URL` is), so a
 * released build can never be pointed somewhere else by an environment variable.
 *
 * @param isPackaged Whether this is a packaged (released) app.
 * @param env The environment.
 * @returns The addresses to use.
 */
export function resolveFeedUrls(isPackaged: boolean, env: Record<string, string | undefined>): FeedUrls {
  if (isPackaged) return REAL_FEED_URLS
  const vatsimOverride = env.WINGLOG_E2E_VATSIM_URL
  return {
    vatsimStatus: vatsimOverride ? null : REAL_FEED_URLS.vatsimStatus,
    vatsimData: vatsimOverride || REAL_FEED_URLS.vatsimData,
    ivao: env.WINGLOG_E2E_IVAO_URL || REAL_FEED_URLS.ivao
  }
}
