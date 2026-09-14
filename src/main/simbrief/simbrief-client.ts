/**
 * SimBrief OFP fetch/parse. Field names and shapes here are verified against a real
 * response from https://www.simbrief.com/api/xml.fetcher.php?username=...&json=1 (not
 * from docs alone, which don't document the JSON schema) — see the M3 commit for the
 * captured example. Two things the docs don't mention but the real response does:
 *
 * - Every numeric value in the JSON is a STRING (e.g. `"33000"`), not a number.
 * - `params.units` is `'kgs'` or `'lbs'` depending on the SimBrief user's own profile
 *   setting — weight/fuel figures are in THAT unit, not a fixed one. Must convert.
 *
 * Times (`times.sched_out` etc.) are unix epoch seconds, converted to ISO 8601 UTC here
 * so the rest of the app never has to know about SimBrief's time format.
 */

const LB_PER_KG = 2.2046226218
const FT_PER_M = 1 / 0.3048

export interface SimBriefStepClimb {
  /** Waypoint where the new cruise altitude begins. */
  atIdent: string
  /** Real feet-equivalent altitude, regardless of which notation the point was coded
   *  in — used for the 'ft' and 'm' AltitudeUnit settings. */
  toAltitudeFt: number
  /** The unit and value this point was actually coded in on the OFP: a standard flight
   *  level is 'ft' (e.g. FL330 -> {unit: 'ft', value: 33000}); a Chinese-airspace metric
   *  level is 'm' (e.g. FL1130 -> {unit: 'm', value: 11300}) — see parseStepClimbs. Used
   *  for the 'hybrid' AltitudeUnit setting. */
  native: { unit: 'ft' | 'm'; value: number }
}

export interface SimBriefOfp {
  ofpId: string
  aircraftIcaoType: string
  /** Tail number from the OFP, for auto-matching against a Fleet aircraft — may not match anything. */
  aircraftRegistration: string
  flightNumber: string
  depIcao: string
  arrIcao: string
  altnIcao: string
  routeString: string
  cruiseAltM: number
  schedOutUtc: string
  schedInUtc: string
  fuelPlannedKg: number
  pax: number
  cargoKg: number
  zfwKg: number
  towKg: number
  ldwKg: number
  /** Plain cost index, no scaling — null if the field is absent (see optNum). */
  costIndex: number | null
  /** Whether this OFP was generated against a saved custom airframe (`aircraft.is_custom`)
   *  rather than SimBrief's own default for the type. See simbriefInternalId. */
  simbriefIsCustom: boolean
  /** `aircraft.internal_id` — for a stock airframe this is just the bare type code
   *  ("A388"), NOT comparable to aircraft.simbrief_airframe_id. Only meaningful (and only
   *  in the `<user id>_<airframe id>` form that simbrief_airframe_id stores) when
   *  simbriefIsCustom is true — docs/simbrief-notes.md, "aircraft — which airframe
   *  profile was used". Callers must check simbriefIsCustom before treating this as an
   *  airframe ID. */
  simbriefInternalId: string | null
  waypoints: { ident: string; altitudeFt: number; distanceNm: number }[]
  /** Planned mid-cruise altitude increases — see parseStepClimbs. */
  stepClimbs: SimBriefStepClimb[]
  /** The full response, stored verbatim per PLAN.md §5 ("Store the raw JSON"). */
  rawJson: string
}

class SimBriefError extends Error {}

function num(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) throw new SimBriefError(`Expected a numeric value, got: ${JSON.stringify(value)}`)
  return n
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '')
}

/**
 * Guarded counterparts of num()/str() for genuinely optional fields (docs/simbrief-notes.md
 * — "empty values come back as {}, not "" or null"). `num()`/`str()` stay as they are for
 * fields already verified to always be populated in practice; any *new* optional field
 * should use these instead, since Number({}) throws and String({}) yields
 * "[object Object]".
 */
export function optNum(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export function optStr(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function epochSecondsToIso(value: unknown): string {
  return new Date(num(value) * 1000).toISOString()
}

/**
 * Recursively searches a parsed JSON value for the first string-valued property named
 * `key`, at any depth. Used instead of a fixed path (e.g. `general.stepclimb_string`)
 * because only the field's name and value have been confirmed against a real SimBrief
 * response — not which section it lives under — see the docs/decisions.md entry for
 * 2026-09-02 on why a third guess at the JSON path was avoided.
 */
function findStringField(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringField(item, key)
      if (found !== undefined) return found
    }
    return undefined
  }
  const record = value as Record<string, unknown>
  if (typeof record[key] === 'string') return record[key] as string
  for (const nested of Object.values(record)) {
    const found = findStringField(nested, key)
    if (found !== undefined) return found
  }
  return undefined
}

// Above the certified ceiling of essentially every civil aircraft — used only as a
// fallback when a step's ident has no navlog match to cross-reference against.
const MAX_PLAUSIBLE_FLIGHT_LEVEL_FT = 52_000

/**
 * Parses SimBrief's `stepclimb_string` field — a flat "IDENT/CODE/IDENT/CODE/..." string
 * that mirrors the "FL STEPS" line on the OFP text itself. Confirmed against a real
 * China-crossing OFP (2026-09-02, see docs/decisions.md):
 * `"EGLL/0330/DENAK/0350/SUDAR/0370/KAMUD/1130/OMBON/1190"`.
 *
 * Each 4-digit code is one of two notations, with nothing in the string marking which:
 * - A standard flight level, in hundreds of feet (e.g. "0330" = FL330 = 33,000 ft).
 * - A metric flight level, used once a flight crosses into airspace (e.g. China) that
 *   assigns levels in metres — in tens of metres (e.g. "1130" = 11,300 m ≈ 37,073 ft).
 *
 * The two ranges genuinely overlap: China's metric RVSM levels run from roughly 600 m to
 * 14,900 m, i.e. codes 0060-0990, so a code alone can't disambiguate (e.g. "0890" is a
 * plausible FL890 *and* a plausible 8,900 m — a real case that broke an earlier
 * code>=1000 threshold, see docs/decisions.md 2026-09-06/07). Resolved instead by
 * cross-referencing `waypointAltitudesFt`, keyed by the same ident the step climb uses
 * (built from the same OFP's `navlog.fix[]`, which gives the real altitude in feet with
 * no guessing) — whichever notation's converted value lands closer to the known altitude
 * wins. Only an ident with no navlog match falls back to a plausibility threshold: a
 * "flight level" above ~FL520 must actually be metric.
 */
export function parseStepClimbs(
  stepclimbString: string | undefined,
  waypointAltitudesFt: ReadonlyMap<string, number> = new Map()
): SimBriefStepClimb[] {
  if (!stepclimbString) return []
  const parts = stepclimbString.split('/')
  const climbs: SimBriefStepClimb[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const atIdent = parts[i]
    const code = Number(parts[i + 1])
    if (!Number.isFinite(code)) continue

    const asFeet = code * 100
    const asMeters = code * 10
    const asMetersInFeet = asMeters * FT_PER_M
    const knownAltitudeFt = waypointAltitudesFt.get(atIdent)

    const isMetric =
      knownAltitudeFt === undefined
        ? asFeet > MAX_PLAUSIBLE_FLIGHT_LEVEL_FT
        : Math.abs(asMetersInFeet - knownAltitudeFt) < Math.abs(asFeet - knownAltitudeFt)

    climbs.push(
      isMetric
        ? { atIdent, toAltitudeFt: asMetersInFeet, native: { unit: 'm', value: asMeters } }
        : { atIdent, toAltitudeFt: asFeet, native: { unit: 'ft', value: asFeet } }
    )
  }
  return climbs
}

/**
 * Parses a SimBrief OFP JSON response (whether freshly fetched or read back out of a
 * flight's own stored `ofpJson`, e.g. to reconstruct Dispatch's view of a flight that
 * survived a restart — see dispatchGetInProgressFlight) into the shape the rest of the
 * app works with. Pulled out of fetchLatestOfp so both callers share one parser rather
 * than fetchLatestOfp being the only place this logic could ever run.
 */
export function parseOfp(raw: unknown): SimBriefOfp {
  if (typeof raw !== 'object' || raw === null) {
    throw new SimBriefError('SimBrief OFP is not a valid JSON object')
  }

  const ofp = raw as Record<string, Record<string, unknown> | undefined>
  if (ofp.fetch?.status !== 'Success') {
    throw new SimBriefError(`SimBrief reported an error: ${JSON.stringify(ofp.fetch)}`)
  }

  const { origin, destination, alternate, general, aircraft, weights, fuel, times, params, navlog } = ofp
  if (!origin || !destination || !general || !aircraft || !weights || !fuel || !times || !params) {
    throw new SimBriefError('SimBrief response is missing an expected top-level section')
  }

  const kgFactor = params.units === 'lbs' ? 1 / LB_PER_KG : 1
  const toKg = (value: unknown): number => num(value) * kgFactor

  const fixes = Array.isArray((navlog as Record<string, unknown> | undefined)?.fix)
    ? ((navlog as { fix: Record<string, unknown>[] }).fix as Record<string, unknown>[])
    : []

  const waypoints = fixes.map((fix) => ({
    ident: str(fix.ident),
    altitudeFt: num(fix.altitude_feet ?? 0),
    distanceNm: num(fix.distance ?? 0)
  }))
  const waypointAltitudesFt = new Map(waypoints.map((w) => [w.ident, w.altitudeFt] as const))

  return {
    ofpId: str(params.request_id),
    aircraftIcaoType: str(aircraft.icaocode),
    aircraftRegistration: str(aircraft.reg),
    flightNumber: `${str(general.icao_airline)}${str(general.flight_number)}`,
    depIcao: str(origin.icao_code),
    arrIcao: str(destination.icao_code),
    altnIcao: str(alternate?.icao_code),
    routeString: str(general.route),
    cruiseAltM: num(general.initial_altitude) * 0.3048,
    schedOutUtc: epochSecondsToIso(times.sched_out),
    schedInUtc: epochSecondsToIso(times.sched_in),
    fuelPlannedKg: toKg(fuel.plan_ramp),
    pax: Math.round(num(weights.pax_count)),
    cargoKg: toKg(weights.cargo),
    zfwKg: toKg(weights.est_zfw),
    towKg: toKg(weights.est_tow),
    ldwKg: toKg(weights.est_ldw),
    costIndex: optNum(general.costindex),
    simbriefIsCustom: str(aircraft.is_custom) === '1',
    simbriefInternalId: optStr(aircraft.internal_id),
    waypoints,
    stepClimbs: parseStepClimbs(findStringField(ofp, 'stepclimb_string'), waypointAltitudesFt),
    rawJson: JSON.stringify(raw)
  }
}

export async function fetchLatestOfp(username: string): Promise<SimBriefOfp> {
  const url = `https://www.simbrief.com/api/xml.fetcher.php?username=${encodeURIComponent(username)}&json=1`
  const response = await fetch(url)
  const raw: unknown = await response.json().catch(() => undefined)

  if (!response.ok) {
    throw new SimBriefError(`SimBrief fetch failed (HTTP ${response.status}) for username "${username}"`)
  }
  return parseOfp(raw)
}
