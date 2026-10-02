// Matches both real captured taxi-clearance shapes (docs/beyondatc-notes.md, "The real taxi
// clearance format", 2026-09-28): a departure clearance names a holding point and runway
// before "via"; an arrival (taxi-to-gate) clearance names a stand instead. Both end the same
// way — a comma-separated list of taxiway names up to the trailing period.
const DEPARTURE_TAXI = /taxi to holding point \S+, runway \S+, via ([A-Z0-9]+(?:, [A-Z0-9]+)*)\.?/i
const ARRIVAL_TAXI = /taxi to stand \S+ via ([A-Z0-9]+(?:, [A-Z0-9]+)*)\.?/i

/**
 * Parses one live BeyondATC `ATC:` transcript line into an ordered list of taxiway names,
 * or `null` if it isn't a taxi clearance — same "degrade, never guess" discipline as
 * atcClearanceParser.ts. Real taxiway names need no reformatting to match the taxi chart's
 * own `TAXI_NAME` data (confirmed live, ZSPD, 2026-09-28 — unlike an approach identifier,
 * a straight string match is enough).
 *
 * v1 deliberately does not resolve this into the *specific* chart segments actually
 * travelled — a taxiway name can appear on many disconnected segments across an airport
 * (no pathfinding through the taxi network graph is attempted here). The caller highlights
 * every segment whose name matches, which is the whole named taxiway, not just the portion
 * this clearance actually uses. A real, known v1 limitation, not an oversight — see
 * flightdeck-backend's docs/plans/beyondatc-taxi-route-highlight.md.
 */
export function parseTaxiRoute(text: string): string[] | null {
  const match = DEPARTURE_TAXI.exec(text) ?? ARRIVAL_TAXI.exec(text)
  if (!match) return null
  return match[1]!.split(',').map((name) => name.trim())
}

const HOLDING_POINT = /taxi to holding point ([A-Z0-9]+),/i

/** "taxi to holding point B10, runway 25C, via B8, B" → 'B10' — the clearance's end point,
 *  which taxiRouteTrace.ts traces the route to. Null for an arrival (taxi-to-stand)
 *  clearance or anything else. */
export function parseTaxiHoldingPoint(text: string): string | null {
  return HOLDING_POINT.exec(text)?.[1] ?? null
}

const STAND = /taxi to stand ([A-Z0-9]+)/i

/** "taxi to Stand N32 via J, H6, H, V, B" → 'N32' (real, VHHH 2026-10-02) — matched against
 *  the sim's stands (stand-positions.md). Null for anything else. */
export function parseTaxiStand(text: string): string | null {
  return STAND.exec(text)?.[1] ?? null
}
