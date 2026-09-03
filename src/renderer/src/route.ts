function navlogFixes(ofpJson: string | null): Record<string, unknown>[] {
  if (!ofpJson) return []
  try {
    const parsed: unknown = JSON.parse(ofpJson)
    const fixes = (parsed as { navlog?: { fix?: unknown } })?.navlog?.fix
    return Array.isArray(fixes) ? (fixes as Record<string, unknown>[]) : []
  } catch {
    return []
  }
}

/** Empty SimBrief fields deserialize to `{}`, not `""` or missing (docs/simbrief-notes.md)
 *  — guard every optional string read from a navlog/general field the same way
 *  simbrief-client.ts's own optStr does, so an absent value never becomes the literal
 *  string "[object Object]". */
function optStr(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function generalSection(ofpJson: string | null): Record<string, unknown> {
  if (!ofpJson) return {}
  try {
    const parsed = JSON.parse(ofpJson) as { general?: unknown }
    return typeof parsed.general === 'object' && parsed.general !== null
      ? (parsed.general as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function apiParamsSection(ofpJson: string | null): Record<string, unknown> {
  if (!ofpJson) return {}
  try {
    const parsed = JSON.parse(ofpJson) as { api_params?: unknown }
    return typeof parsed.api_params === 'object' && parsed.api_params !== null
      ? (parsed.api_params as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/**
 * Extracts the planned route as [lon, lat] pairs (GeoJSON order) from a flight's raw
 * SimBrief OFP JSON — specifically `navlog.fix[].pos_lat`/`pos_long`, sim-confirmed real
 * field names/shapes during M3 (docs/decisions.md, 2026-09-01 dispatch entry). Returns an
 * empty route rather than throwing on anything unexpected — a missing planned route just
 * means the map has no line to draw, not a reason to break the page.
 */
export function parseRouteFromOfpJson(ofpJson: string | null): [number, number][] {
  const points: [number, number][] = []
  for (const fix of navlogFixes(ofpJson)) {
    const lon = Number(fix.pos_long)
    const lat = Number(fix.pos_lat)
    if (Number.isFinite(lon) && Number.isFinite(lat)) points.push([lon, lat])
  }
  return points
}

export type RouteSegment = 'sid' | 'enroute' | 'star'

export interface Waypoint {
  ident: string
  lon: number
  lat: number
  altitudeFt: number
  /** Which part of the route this fix belongs to — see segmentWaypoints below. Always
   *  'enroute' when the OFP names no SID/STAR at all. */
  segment: RouteSegment
}

/** SimBrief's stated procedure names for a route — `general.sid_ident`/`star_ident` (and
 *  their `_trans` transitions), plus the departure/arrival runway from `api_params.origrwy`/
 *  `destrwy` (confirmed real, echoed-back generation inputs — docs/simbrief-notes.md).
 *  All guarded against the `{}`-when-absent trap — null means SimBrief didn't fly/report
 *  that piece. Exposed separately from the waypoint list so a UI can label the route (or
 *  autofill a procedure picker) without re-deriving any of it from the segmented fixes. */
export interface RouteProcedures {
  departureRunway: string | null
  sidIdent: string | null
  sidTransition: string | null
  starIdent: string | null
  starTransition: string | null
  arrivalRunway: string | null
}

export function parseRouteProcedures(ofpJson: string | null): RouteProcedures {
  const general = generalSection(ofpJson)
  const apiParams = apiParamsSection(ofpJson)
  return {
    departureRunway: optStr(apiParams.origrwy),
    sidIdent: optStr(general.sid_ident),
    sidTransition: optStr(general.sid_trans),
    starIdent: optStr(general.star_ident),
    starTransition: optStr(general.star_trans),
    arrivalRunway: optStr(apiParams.destrwy)
  }
}

/**
 * Splits a navlog into SID / enroute / STAR segments — verified against real SimBrief
 * responses with and without transitions (docs/simbrief-notes.md, 2026-09-02/03
 * sid-star-selection entries). This only labels SimBrief's own chosen procedure; swapping
 * in an alternate one needs real navdata (Navigraph) and is blocked on API credentials —
 * see docs/decisions.md's sid-star-selection entry for why this half ships alone.
 *
 * The rule, confirmed against three real shapes (full SID+transition/STAR+transition, SID
 * /STAR without transitions, and SID-only with no STAR):
 * - SID = the leading run of fixes, from the start, while `via_airway === sid_ident`.
 *   Correctly includes a SID's transition handoff fix (its via_airway is still the SID
 *   name, never the transition's own name — transitions have no via_airway of their own).
 * - STAR = from the fix whose `ident === star_trans` when a transition is set (the STAR's
 *   handoff fix carries via_airway = the *inbound enroute airway*, not the STAR itself, so
 *   via_airway alone can't find it), else from the first fix with `via_airway ===
 *   star_ident`; runs to the very last fix, which is the destination airport itself.
 * - Enroute = everything between.
 */
export function segmentWaypoints(ofpJson: string | null): Waypoint[] {
  const general = generalSection(ofpJson)
  const sidIdent = optStr(general.sid_ident)
  const starIdent = optStr(general.star_ident)
  const starTrans = optStr(general.star_trans)

  const raw = navlogFixes(ofpJson)
    .map((fix) => ({
      ident: typeof fix.ident === 'string' ? fix.ident : '',
      lon: Number(fix.pos_long),
      lat: Number(fix.pos_lat),
      altitudeFt: Number(fix.altitude_feet ?? 0),
      viaAirway: optStr(fix.via_airway)
    }))
    .filter((fix) => fix.ident && Number.isFinite(fix.lon) && Number.isFinite(fix.lat))

  let sidEnd = 0
  if (sidIdent) {
    while (sidEnd < raw.length && raw[sidEnd].viaAirway === sidIdent) sidEnd++
  }

  let starStart = raw.length
  if (starTrans) {
    const idx = raw.findIndex((fix) => fix.ident === starTrans)
    if (idx !== -1) starStart = idx
  } else if (starIdent) {
    const idx = raw.findIndex((fix) => fix.viaAirway === starIdent)
    if (idx !== -1) starStart = idx
  }
  // A STAR can never start before the SID ends — guards a pathological OFP where a
  // coincidental ident/via_airway match would otherwise overlap or invert the segments.
  starStart = Math.max(starStart, sidEnd)

  return raw.map((fix, i) => ({
    ident: fix.ident,
    lon: fix.lon,
    lat: fix.lat,
    altitudeFt: fix.altitudeFt,
    segment: i < sidEnd ? 'sid' : i >= starStart ? 'star' : 'enroute'
  }))
}

/**
 * Extracts per-fix waypoint markers (ident + altitude + segment), same source as
 * parseRouteFromOfpJson. Same "empty rather than throw" behavior as that function —
 * segmentWaypoints already guards every field it reads.
 */
export function parseWaypointsFromOfpJson(ofpJson: string | null): Waypoint[] {
  return segmentWaypoints(ofpJson)
}

/**
 * `general.route` (e.g. "DET2G DET L6 DVR UL9 KONAN ...") with the SID/STAR and their
 * transitions stripped out, now that they're shown separately (the Procedures box) rather
 * than inline here. Filters by token membership instead of reconstructing the string:
 * drops any token that's either a procedure/transition name itself, or the ident of a fix
 * segmentWaypoints classified as 'sid'/'star' — the same segmentation the map's waypoint
 * colouring already uses, so this text and the map always agree on where the procedures
 * are. Airway names (`L6`, `UL9`) are never fix idents, so they're left alone; a lone
 * airway token that only ever led into a now-removed procedure can be left dangling at the
 * end of the string — a rare cosmetic leftover, not worth a heuristic for a display string.
 */
export function formatEnrouteOnly(ofpJson: string | null): string {
  const general = generalSection(ofpJson)
  const raw = typeof general.route === 'string' ? general.route : ''
  if (!raw) return raw

  const { sidIdent, sidTransition, starIdent, starTransition } = parseRouteProcedures(ofpJson)
  const procedureNames = new Set(
    [sidIdent, sidTransition, starIdent, starTransition].filter((v): v is string => v !== null)
  )
  const procedureFixIdents = new Set(
    segmentWaypoints(ofpJson)
      .filter((w) => w.segment !== 'enroute')
      .map((w) => w.ident)
  )

  return raw
    .split(/\s+/)
    .filter((token) => token && !procedureNames.has(token) && !procedureFixIdents.has(token))
    .join(' ')
}
