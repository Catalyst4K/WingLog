import type { SimbriefAirframeOption } from '../../shared/ipc'

// Forum-documented, not in SimBrief's own official docs (docs/plans/
// simbrief-airframe-picker.md) — same undocumented-external-system status as SimBrief's
// OFP JSON schema. Fetched live, never vendored/stored — nothing here is redistributed by
// Flightdeck, same model as fx-client.ts's Frankfurter call.
const AIRFRAMES_URL = 'https://www.simbrief.com/api/inputs.airframes.json'

export interface RawAirframe {
  airframe_id: number | false
  pilot_id: number | false
  airframe_internal_id: string
  airframe_comments: string
  airframe_engines: string
  airframe_registration: string
}

export interface RawAircraftEntry {
  aircraft_icao: string
  airframes: RawAirframe[]
}

export type RawAirframesResponse = Record<string, RawAircraftEntry>

// Matches SimBrief's own near-universal comment shape, e.g. "Fenix Simulations (MSFS) -
// A320 CFM (SL)" or "ToLiss (X-Plane) - CFM56-5B4 [credit: Rodeo314]" — confirmed against
// 291 real community entries across 12 popular types, 96.6% match (docs/plans/
// simbrief-airframe-picker.md). The 3.4% that don't match (plain strings with no real
// payware addon, e.g. "Lockheed C-130K Hercules [credit: KevinAviationHD]") fall back to
// null developer/platform — comments is always present regardless.
const COMMENT_PATTERN = /^(.+?)\s+\(([^)]+)\)\s*-\s*(.+)$/

function parseDeveloperAndPlatform(comments: string): { developer: string | null; platform: string | null } {
  const match = comments.match(COMMENT_PATTERN)
  if (!match) return { developer: null, platform: null }
  return { developer: match[1].trim(), platform: match[2].trim() }
}

function toOption(raw: RawAirframe, simbriefType: string): SimbriefAirframeOption {
  const isDefault = raw.airframe_id === false
  const { developer } = parseDeveloperAndPlatform(raw.airframe_comments)
  return {
    isDefault,
    developer,
    engines: raw.airframe_engines,
    comments: raw.airframe_comments,
    registration: raw.airframe_registration || null,
    simbriefType,
    shareUrl: isDefault ? null : `https://dispatch.simbrief.com/airframes/share/${raw.airframe_internal_id}`
  }
}

/**
 * Parses the raw `inputs.airframes.json` shape into this app's own option list for one
 * ICAO type — filtered to `MSFS`-platform community entries plus the always-present stock
 * default (docs/plans/simbrief-airframe-picker.md). Exported separately from the fetch
 * below so real captured fixture JSON can be tested without a network call.
 */
export function parseAirframesForType(data: RawAirframesResponse, icaoType: string): SimbriefAirframeOption[] {
  const entry = data[icaoType]
  if (!entry) return []

  return entry.airframes
    .filter((raw) => {
      if (raw.airframe_id === false) return true // always keep the stock default
      const { platform } = parseDeveloperAndPlatform(raw.airframe_comments)
      // Only exclude an entry explicitly tagged for a different sim — a comment with no
      // parseable platform at all (the 3.4% fallback case) isn't confirmed X-Plane/P3D
      // either, and excluding it would silently drop real MSFS-relevant entries for a
      // niche type with no payware addon to name (e.g. a plain freeware C-130 comment).
      return platform === null || platform === 'MSFS'
    })
    .map((raw) => toOption(raw, entry.aircraft_icao))
}

// Parsed on first request, not at module load — no session ever needing this shouldn't pay
// to fetch/parse a ~930KB response (same "lazy, cached for the process lifetime" reasoning
// as airport-search.ts's allAirports/airportCoords). No on-disk cache: this is a browse
// list, not something that needs surviving a restart, and the source is only ever "updated
// every 5 minutes" (unconfirmed, forum post) — a longer cache would just risk staleness.
let cachedResponse: Promise<RawAirframesResponse | null> | null = null

async function fetchAirframesData(): Promise<RawAirframesResponse | null> {
  cachedResponse ??= fetch(AIRFRAMES_URL)
    .then((res) => (res.ok ? (res.json() as Promise<RawAirframesResponse>) : null))
    .catch(() => null)
  return cachedResponse
}

/** Empty (not an error) for a type SimBrief doesn't recognise, or if the fetch itself
 *  fails — same defensive-parsing posture as every other external-data path in this app. */
export async function fetchAirframesForType(icaoType: string): Promise<SimbriefAirframeOption[]> {
  const data = await fetchAirframesData()
  if (!data) return []
  return parseAirframesForType(data, icaoType)
}
