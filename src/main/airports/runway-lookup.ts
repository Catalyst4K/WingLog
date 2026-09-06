// Runway threshold geometry for landing analysis (PLAN.md M6) — resources/runways.csv, a
// trimmed slice of OurAirports' runways.csv (public domain, see
// resources/runways.LICENSE.txt and scripts/vendor-runways.mjs), one row per usable
// runway end (heading + threshold position both present) for airports already in this
// app's vendored resources/airports.csv. Bundled via Vite's `?raw` import, same pattern
// as airport-search.ts/icao-types.ts.
import { columnIndex, parseCsvRows } from '../db/csv'
import { angularDifference } from './landing-maths'
import runwaysRaw from '../../../resources/runways.csv?raw'

export interface RunwayEnd {
  icao: string
  ident: string
  lat: number
  lon: number
  headingTrueDeg: number
}

export function loadRunwayEnds(raw: string): RunwayEnd[] {
  const [header, ...rows] = parseCsvRows(raw)
  const icaoIdx = columnIndex(header, 'icao')
  const identIdx = columnIndex(header, 'ident')
  const latIdx = columnIndex(header, 'lat')
  const lonIdx = columnIndex(header, 'lon')
  const hdgIdx = columnIndex(header, 'heading_true_deg')

  const ends: RunwayEnd[] = []
  for (const row of rows) {
    const lat = Number(row[latIdx])
    const lon = Number(row[lonIdx])
    const headingTrueDeg = Number(row[hdgIdx])
    if (!row[icaoIdx] || !row[identIdx] || !Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(headingTrueDeg)) {
      continue
    }
    ends.push({ icao: row[icaoIdx].toUpperCase(), ident: row[identIdx], lat, lon, headingTrueDeg })
  }
  return ends
}

// Rough proxy for "is this candidate end even in the right place" — 1 degree of
// latitude is ~111 km, far larger than any runway, but small enough to reliably tell two
// different airports' runway ends apart without doing real great-circle distance for a
// resolver that only ever compares candidates already filtered to one airport's ICAO.
function roughDistance(aLat: number, aLon: number, bLat: number, bLon: number): number {
  return Math.hypot(aLat - bLat, aLon - bLon)
}

// A touchdown heading more than this far from a runway end's published heading isn't
// plausibly that end (e.g. matching 09 to a landing that was actually on 27) — leaves
// resolveRunwayEnd to correctly return null rather than a confidently wrong runway.
const MAX_HEADING_DIFFERENCE_DEG = 45

/**
 * Resolves a touchdown ICAO + heading + rough position to the nearest matching runway
 * end. Two candidate ends can share the same published heading (parallel runways, e.g.
 * 25L/25R) — proximity to the touchdown position breaks that tie, which is exactly the
 * case a naive "closest heading only" resolver gets silently wrong.
 */
export function resolveRunwayEnd(
  ends: RunwayEnd[],
  icao: string,
  touchdownHeadingDeg: number,
  touchdownLat: number,
  touchdownLon: number
): RunwayEnd | null {
  const upperIcao = icao.toUpperCase()
  let best: RunwayEnd | null = null
  let bestScore = Infinity

  for (const end of ends) {
    if (end.icao !== upperIcao) continue
    const headingDiff = angularDifference(touchdownHeadingDeg, end.headingTrueDeg)
    if (headingDiff > MAX_HEADING_DIFFERENCE_DEG) continue

    // Heading match dominates the score; distance only breaks ties between ends whose
    // headings are equally (or near-equally) plausible.
    const score = headingDiff * 1000 + roughDistance(touchdownLat, touchdownLon, end.lat, end.lon)
    if (score < bestScore) {
      bestScore = score
      best = end
    }
  }
  return best
}

// Parsed on first use, not at module load (docs/decisions.md, memory-usage entry) — same
// reasoning as airport-search.ts. This one's real use (a touchdown) can be hours into a
// session, so deferring the parse to then still matters even though every flight
// eventually needs it.
let allRunwayEnds: RunwayEnd[] | null = null
function getAllRunwayEnds(): RunwayEnd[] {
  return (allRunwayEnds ??= loadRunwayEnds(runwaysRaw))
}

export function findRunwayEnd(
  icao: string,
  touchdownHeadingDeg: number,
  touchdownLat: number,
  touchdownLon: number
): RunwayEnd | null {
  return resolveRunwayEnd(getAllRunwayEnds(), icao, touchdownHeadingDeg, touchdownLat, touchdownLon)
}

/**
 * A rough "somewhere at this airport" anchor point — the mean of all its runway ends'
 * thresholds, not any specific runway. Good enough for a sanity check on whether a
 * telemetry sample is plausibly at this airport at all (AutoStartDetector's departure-
 * position guard); not precise enough for anything that needs a real position, which is
 * what findRunwayEnd/resolveRunwayEnd are for. Null when the ICAO isn't in the vendored
 * runway data at all (the check this feeds should then skip itself, not reject everything).
 */
export function resolveAirportPosition(ends: RunwayEnd[], icao: string): { lat: number; lon: number } | null {
  const upperIcao = icao.toUpperCase()
  const matches = ends.filter((end) => end.icao === upperIcao)
  if (matches.length === 0) return null
  return {
    lat: matches.reduce((sum, end) => sum + end.lat, 0) / matches.length,
    lon: matches.reduce((sum, end) => sum + end.lon, 0) / matches.length
  }
}

export function airportPosition(icao: string): { lat: number; lon: number } | null {
  return resolveAirportPosition(getAllRunwayEnds(), icao)
}
