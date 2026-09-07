// Runway threshold geometry for landing analysis (PLAN.md M6) — resources/runways.csv, a
// trimmed slice of OurAirports' runways.csv (public domain, see
// resources/runways.LICENSE.txt and scripts/vendor-runways.mjs), one row per usable
// runway end (heading + threshold position both present) for airports already in this
// app's vendored resources/airports.csv. Bundled via Vite's `?raw` import, same pattern
// as airport-search.ts/icao-types.ts.
import { columnIndex, parseCsvRows } from '../db/csv'
import { angularDifference, positionRelativeToRunway } from './landing-maths'
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

// A touchdown heading more than this far from a runway end's published heading isn't
// plausibly that end (e.g. matching 09 to a landing that was actually on 27). Wide on
// purpose (was 45): heading's only real job here is picking which end of a strip was
// used and rejecting the reciprocal — the geometry gates below do the actual work of
// telling parallel runways apart, so heading doesn't need to be tight too.
const MAX_HEADING_DIFFERENCE_DEG = 90

// How far off the centreline a touchdown can be and still count as "on this runway".
// Fixed and generous pending real per-runway width data (Phase 1, resources/runways.csv
// re-vendored with `width_ft`) — real runways are 30-90m wide, so 100m already rejects a
// different, parallel strip while tolerating GPS/heading noise on the real one.
const LATERAL_TOLERANCE_M = 100

// Along-track bounds a touchdown must fall within, relative to the threshold. Small
// negative slack for GPS/threshold-position noise; the upper bound is a fixed generous
// stand-in for real runway length (Phase 1) — the longest paved runways run to ~5.5km.
const MIN_ALONG_TRACK_M = -50
const MAX_ALONG_TRACK_M = 6000

/**
 * Resolves a touchdown ICAO + heading + position to the matching runway end, using real
 * geometry rather than heading alone. Two candidate ends can share the same published
 * heading (parallel runways, e.g. 25L/25R) or, per real OurAirports data, publish
 * slightly *different* integer-rounded headings for what are physically parallel strips
 * (VHHH's 07L at 74°, 07C/07R at 71°) — either way, only position relative to each
 * candidate's own threshold can tell them apart. A touchdown must fall within
 * LATERAL_TOLERANCE_M of a candidate's centreline and within its along-track bounds to
 * be considered at all; heading only breaks a tie between geometrically-plausible
 * survivors.
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

    const { distanceFromThresholdM, centrelineOffsetM } = positionRelativeToRunway(
      touchdownLat,
      touchdownLon,
      end.lat,
      end.lon,
      end.headingTrueDeg
    )
    if (distanceFromThresholdM < MIN_ALONG_TRACK_M || distanceFromThresholdM > MAX_ALONG_TRACK_M) continue
    if (Math.abs(centrelineOffsetM) > LATERAL_TOLERANCE_M) continue

    // Position dominates the score — a candidate only reaches here already confirmed to
    // be physically underneath the touchdown, so heading is a weak tiebreak between two
    // otherwise-plausible ends, not the deciding factor.
    const score = Math.abs(centrelineOffsetM) * 10 + headingDiff
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
