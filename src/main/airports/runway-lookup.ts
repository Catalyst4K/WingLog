// Runway threshold geometry for landing analysis (PLAN.md M6) — resources/runways.csv, a
// trimmed slice of OurAirports' runways.csv (public domain, see
// resources/runways.LICENSE.txt and scripts/vendor-runways.mjs), one row per usable
// runway end (heading + threshold position both present) for airports already in this
// app's vendored resources/airports.csv. Bundled via Vite's `?raw` import, same pattern
// as airport-search.ts/icao-types.ts.
import { columnIndex, parseCsvRows } from '../db/csv'
import { angularDifference, positionRelativeToRunway, type RunwayRelativePosition } from './landing-maths'
import runwaysRaw from '../../../resources/runways.csv?raw'

export interface RunwayEnd {
  icao: string
  ident: string
  /** This end's own physical threshold position — OurAirports' `le_latitude_deg`/
   *  `he_latitude_deg` etc., the centre of the physical runway end (length_ft's own
   *  definition explicitly includes displaced thresholds, confirmed against OurAirports'
   *  data dictionary), not the displacement-adjusted usable threshold. Matching/gating
   *  below is deliberately done against this physical point — a touchdown short of a
   *  displaced threshold but still on the paved surface is still "on this runway", not a
   *  different one. Use distanceFromUsableThresholdM for the distance actually reported. */
  lat: number
  lon: number
  headingTrueDeg: number
  /** Full paved surface length (both ends share the same value) — Phase 1,
   *  resources/runways.csv's `length_ft`. Null when OurAirports has no value for this
   *  runway (common for smaller/regional airports). */
  lengthM: number | null
  /** Paved surface width (both ends share the same value). Null when unknown. */
  widthM: number | null
  /** How far this end's usable landing threshold sits inboard of the physical end above,
   *  in the direction of the opposite end — 0 when not displaced (the common case) or
   *  unknown, never null: "unknown" and "not displaced" are handled the same way here,
   *  since a displacement this code doesn't know about is indistinguishable from none. */
  displacedThresholdM: number
  /** This end's elevation above MSL. Null when unknown. */
  elevationM: number | null
  /** OurAirports' free-text surface code (`ASP`, `CON`, `GRS`, ...), not a controlled
   *  vocabulary — kept as-is rather than parsed into an enum. Null when unknown. */
  surface: string | null
  /** ICAO Annex 14 aiming-point-marking distance from the threshold for this runway's
   *  length band (see aimingPointDistanceForLengthM) — null when lengthM is unknown. */
  aimingPointDistanceM: number | null
}

const FEET_TO_METERS = 0.3048

function feetToMetersOrNull(raw: string | undefined): number | null {
  if (!raw) return null
  const feet = Number(raw)
  return Number.isFinite(feet) ? feet * FEET_TO_METERS : null
}

/**
 * ICAO Annex 14, Vol I, §5.2.5 (aiming point marking) — the marking's distance from the
 * threshold depends on the runway's landing distance available. Sourced from the Manual
 * of Aerodrome Standards' Table 9-1 (a secondary source; the ≥2400m band was independently
 * confirmed against the primary Annex 14 text before this table was written) — worth a
 * cross-check against a primary ICAO source if this ever needs to be authoritative rather
 * than an informational display value. Null when lengthM itself is unknown.
 */
export function aimingPointDistanceForLengthM(lengthM: number | null): number | null {
  if (lengthM === null) return null
  if (lengthM < 800) return 150
  if (lengthM < 1200) return 250
  if (lengthM < 2400) return 300
  return 400
}

export function loadRunwayEnds(raw: string): RunwayEnd[] {
  const [header, ...rows] = parseCsvRows(raw)
  const icaoIdx = columnIndex(header, 'icao')
  const identIdx = columnIndex(header, 'ident')
  const latIdx = columnIndex(header, 'lat')
  const lonIdx = columnIndex(header, 'lon')
  const hdgIdx = columnIndex(header, 'heading_true_deg')
  const lengthIdx = columnIndex(header, 'length_ft')
  const widthIdx = columnIndex(header, 'width_ft')
  const displacedIdx = columnIndex(header, 'displaced_threshold_ft')
  const elevationIdx = columnIndex(header, 'elevation_ft')
  const surfaceIdx = columnIndex(header, 'surface')

  const ends: RunwayEnd[] = []
  for (const row of rows) {
    const lat = Number(row[latIdx])
    const lon = Number(row[lonIdx])
    const headingTrueDeg = Number(row[hdgIdx])
    if (!row[icaoIdx] || !row[identIdx] || !Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(headingTrueDeg)) {
      continue
    }
    const lengthM = feetToMetersOrNull(row[lengthIdx])
    ends.push({
      icao: row[icaoIdx].toUpperCase(),
      ident: row[identIdx],
      lat,
      lon,
      headingTrueDeg,
      lengthM,
      widthM: feetToMetersOrNull(row[widthIdx]),
      displacedThresholdM: feetToMetersOrNull(row[displacedIdx]) ?? 0,
      elevationM: feetToMetersOrNull(row[elevationIdx]),
      surface: row[surfaceIdx] || null,
      aimingPointDistanceM: aimingPointDistanceForLengthM(lengthM)
    })
  }
  return ends
}

// A touchdown heading more than this far from a runway end's published heading isn't
// plausibly that end (e.g. matching 09 to a landing that was actually on 27). Wide on
// purpose (was 45): heading's only real job here is picking which end of a strip was
// used and rejecting the reciprocal — the geometry gates below do the actual work of
// telling parallel runways apart, so heading doesn't need to be tight too.
const MAX_HEADING_DIFFERENCE_DEG = 90

// How far off the centreline a touchdown can be and still count as "on this runway", when
// a candidate's own real widthM (Phase 1) isn't known — real runways are 30-90m wide, so
// 100m already rejects a different, parallel strip while tolerating GPS/heading noise on
// the real one. Used as a fallback only; see runwayLateralToleranceM below.
const FALLBACK_LATERAL_TOLERANCE_M = 100

// Along-track bounds a touchdown must fall within, relative to the threshold. Small
// negative slack for GPS/threshold-position noise, always applied regardless of real data
// (it isn't a physical fact about the runway, just tolerance for a touchdown detected a
// few metres before the geometric threshold). The upper bound falls back to this fixed
// generous stand-in — the longest paved runways run to ~5.5km — only when a candidate's
// own real lengthM (Phase 1) isn't known.
const MIN_ALONG_TRACK_M = -50
const FALLBACK_MAX_ALONG_TRACK_M = 6000

// Half the real runway width undershoots the tolerance a derived (not GPS-direct)
// touchdown position needs — the telemetry tick nearest the ground-contact transition can
// sit a handful of metres off the true touchdown point. This margin is added on top of the
// real half-width; it isn't itself a physical runway dimension, just noise headroom, kept
// the same regardless of runway size.
const LATERAL_NOISE_MARGIN_M = 20

function runwayLateralToleranceM(end: RunwayEnd): number {
  return end.widthM === null ? FALLBACK_LATERAL_TOLERANCE_M : end.widthM / 2 + LATERAL_NOISE_MARGIN_M
}

function runwayMaxAlongTrackM(end: RunwayEnd): number {
  return end.lengthM ?? FALLBACK_MAX_ALONG_TRACK_M
}

/** Distance from this end's real, usable (displacement-adjusted) landing threshold — what
 *  should actually be reported/stored, as opposed to `position.distanceFromThresholdM`
 *  (distance from the physical runway end, which is what resolveRunwayEnd's gating uses;
 *  see RunwayEnd.lat's doc comment for why those are deliberately different points). */
export function distanceFromUsableThresholdM(position: RunwayRelativePosition, end: RunwayEnd): number {
  return position.distanceFromThresholdM - end.displacedThresholdM
}

/**
 * Resolves a touchdown ICAO + heading + position to the matching runway end, using real
 * geometry rather than heading alone. Two candidate ends can share the same published
 * heading (parallel runways, e.g. 25L/25R) or, per real OurAirports data, publish
 * slightly *different* integer-rounded headings for what are physically parallel strips
 * (VHHH's 07L at 74°, 07C/07R at 71°) — either way, only position relative to each
 * candidate's own threshold can tell them apart. A touchdown must fall within a
 * candidate's own real lateral tolerance (half its published width, plus a fixed noise
 * margin — resources/runways.csv's `width_ft`, Phase 1) of its centreline and within its
 * along-track bounds (its own real length, same source) to be considered at all; heading
 * only breaks a tie between geometrically-plausible survivors. Falls back to fixed,
 * generous defaults for the rare candidate missing that data.
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
    if (distanceFromThresholdM < MIN_ALONG_TRACK_M || distanceFromThresholdM > runwayMaxAlongTrackM(end)) continue
    if (Math.abs(centrelineOffsetM) > runwayLateralToleranceM(end)) continue

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
