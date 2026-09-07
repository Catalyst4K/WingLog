/**
 * Aircraft registration lookup via adsbdb.com (docs/decisions.md, 2026-09-01) — free,
 * keyless, no documented rate limit. Verified against a real live response, not just its
 * docs:
 *
 *   GET https://api.adsbdb.com/v0/aircraft/G-XWBS
 *   { "response": { "aircraft": { "type": "A350-1041", "icao_type": "A35K",
 *       "manufacturer": "Airbus Sas", "registered_owner": "British Airways",
 *       "registered_owner_operator_flag_code": "BAW", ... } } }
 *
 * `registered_owner_operator_flag_code` (verified on real Cathay Pacific/British Airways
 * responses) is the operator's actual ICAO code — used to resolve the exact vendored
 * airline entry rather than fuzzy-matching `registered_owner`'s free-text name against it
 * (which breaks on real mismatches like adsbdb's "Cathay Pacific Airways" vs. the vendored
 * data's "Cathay Pacific" — a shorter name is never a substring match for a longer query).
 *
 * A registration with no match returns a plain HTTP 404 with no body (verified against a
 * made-up registration) — treated here as a normal "not found" outcome (`null`), not an
 * error, since the Fleet UI falls back to manual type search rather than showing a
 * failure. Attribution ("PlaneBase") is required by adsbdb's terms — shown in the Fleet
 * UI next to the lookup button, not just buried in this comment.
 */
import type { AircraftLookupResult } from '@shared/ipc'

class AdsbdbError extends Error {}

interface AdsbdbAircraft {
  icao_type?: unknown
  registered_owner?: unknown
  registered_owner_operator_flag_code?: unknown
  url_photo_thumbnail?: unknown
}

export async function fetchAircraftByRegistration(
  registration: string
): Promise<AircraftLookupResult | null> {
  const url = `https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(registration)}`
  const response = await fetch(url)
  if (response.status === 404) return null

  const raw: unknown = await response.json().catch(() => undefined)
  if (!response.ok || typeof raw !== 'object' || raw === null) {
    throw new AdsbdbError(`adsbdb lookup failed (HTTP ${response.status}) for registration "${registration}"`)
  }

  const aircraft = (raw as { response?: { aircraft?: AdsbdbAircraft } }).response?.aircraft
  if (!aircraft || typeof aircraft.icao_type !== 'string' || !aircraft.icao_type) {
    throw new AdsbdbError(`adsbdb response for "${registration}" is missing the expected aircraft data`)
  }

  return {
    icaoType: aircraft.icao_type,
    operator: typeof aircraft.registered_owner === 'string' ? aircraft.registered_owner : null,
    operatorIcao:
      typeof aircraft.registered_owner_operator_flag_code === 'string'
        ? aircraft.registered_owner_operator_flag_code
        : null,
    // Deliberately url_photo_thumbnail, not url_photo (full-size) — see
    // docs/decisions.md, 2026-09-07: the full-size URL 404s consistently in practice.
    photoThumbnailUrl: typeof aircraft.url_photo_thumbnail === 'string' ? aircraft.url_photo_thumbnail : null
  }
}
