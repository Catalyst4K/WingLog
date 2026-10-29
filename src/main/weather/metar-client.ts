/**
 * METAR lookup via aviationweather.gov's public Data API (NOAA/NWS Aviation Weather Center): free, keyless, public-domain US
 * government data (docs/decisions.md Track METAR entry). Its usage guidance (aviationweather.gov/data/api) caps
 * clients at 100 requests a minute and asks each to send its own User-Agent, which every request here does.
 *
 *   GET https://aviationweather.gov/api/data/metar?ids=EGLL,KJFK&format=json
 *   [{ "icaoId": "EGLL", "rawOb": "METAR EGLL 012320Z AUTO 25008KT 9999 NCD 18/12 Q1020",
 * "reportTime": "2026-09-01T23:20:00.000Z", "fltCat": "VFR",... },...]
 *
 * A request where every code is unknown or non-reporting returns HTTP 204 with an empty body; a request mixing known and
 * unknown codes just omits the unknown ones from the array. Both are the normal "nothing to report for this code" outcome here,
 * not an error.
 */
import type { MetarReport } from '@shared/ipc'

/** Where the METARs are read from. */
export const METAR_URL = 'https://aviationweather.gov/api/data/metar'

/**
 * Where to read METARs: the end-to-end test override is honoured only in an unpackaged app (as the update and feed addresses are), so a
 * released build can never be pointed somewhere else by an environment variable.
 *
 * @param isPackaged Whether this is a packaged (released) app.
 * @param env The environment.
 * @returns The address to use.
 */
export function resolveMetarUrl(isPackaged: boolean, env: Record<string, string | undefined>): string {
  return isPackaged ? METAR_URL : env.WINGLOG_E2E_METAR_URL || METAR_URL
}

class MetarError extends Error {}

interface AviationWeatherMetar {
  icaoId?: unknown
  rawOb?: unknown
  reportTime?: unknown
  fltCat?: unknown
}

function isFlightCategory(value: unknown): value is MetarReport['flightCategory'] {
  return value === 'VFR' || value === 'MVFR' || value === 'IFR' || value === 'LIFR'
}

/**
 * Fetches the current METARs from aviationweather.gov.
 *
 * @param icaoCodes The airports, from the renderer.
 * @param userAgent The User-Agent to send.
 * @param baseUrl Where to read them: the real service unless an end-to-end test says otherwise (`resolveMetarUrl`).
 * @returns A METAR for each airport that has one.
 */
export async function fetchMetars(
  icaoCodes: unknown,
  userAgent = 'WingLog',
  baseUrl = METAR_URL
): Promise<MetarReport[]> {
  // From the renderer: only ICAO-shaped strings go into the query.
  if (!Array.isArray(icaoCodes)) return []
  const codes = [
    ...new Set(
      icaoCodes
        .filter((c): c is string => typeof c === 'string')
        .map((c) => c.trim().toUpperCase())
        .filter((c) => /^[A-Z0-9]{3,4}$/.test(c))
    )
  ]
  if (codes.length === 0) return []

  const url = `${baseUrl}?ids=${encodeURIComponent(codes.join(','))}&format=json`
  const response = await fetch(url, { headers: { 'User-Agent': userAgent } })
  if (response.status === 204) return []
  if (!response.ok) {
    throw new MetarError(`METAR lookup failed (HTTP ${response.status}) for ${codes.join(', ')}`)
  }

  const raw: unknown = await response.json().catch(() => undefined)
  if (!Array.isArray(raw)) return []

  return (raw as AviationWeatherMetar[])
    .filter(
      (m): m is AviationWeatherMetar & { icaoId: string; rawOb: string } =>
        typeof m.icaoId === 'string' && typeof m.rawOb === 'string'
    )
    .map((m) => ({
      icao: m.icaoId,
      rawText: m.rawOb,
      observedUtc: typeof m.reportTime === 'string' ? m.reportTime : '',
      flightCategory: isFlightCategory(m.fltCat) ? m.fltCat : null
    }))
}
