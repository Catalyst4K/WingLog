/** Touchdown records and their scores. */

/** One flight's touchdown record — see docs/decisions.md's landing-analysis entry.
 *  `runwayIdent`/`distanceFromThresholdM`/`centrelineOffsetM`/`headwindMs`/`crosswindMs`/
 *  `crabDeg` are null when no matching runway end was found (resources/runways.csv has no
 *  entry for the airport, or none within a plausible heading tolerance of the touchdown). */
export interface Landing {
  id: number
  flightId: number
  /** 1-based, per flight, in touchdown order (winglog-backend's docs/plans/
   *  multiple-landings.md) — a flight can have several, one per real touchdown. */
  seq: number
  /** The airport this specific touchdown happened at, resolved from position at capture
   *  time — not necessarily the flight's filed arrival (a circuit, a diversion, a free
   *  flight with no filed one). Null when nothing vendored was in range. */
  icao: string | null
  touchdownTsUtc: string
  verticalSpeedMs: number
  gForce: number
  pitchDeg: number
  bankDeg: number
  headingTrueDeg: number
  indicatedAirspeedMs: number
  groundSpeedMs: number
  windSpeedMs: number
  windDirectionDeg: number
  headwindMs: number | null
  crosswindMs: number | null
  /** Signed angle between the nose and runway centreline at touchdown — see
   *  landing-maths.ts's crabAngleDeg. Positive = nose right of the runway heading. */
  crabDeg: number | null
  runwayIdent: string | null
  distanceFromThresholdM: number | null
  centrelineOffsetM: number | null
  flapSetting: number | null
  /** Always 'derived' for now — see the schema.ts column comment. */
  touchdownSource: 'simvar' | 'derived'
}

/** One row per aircraft-with-a-landing-record, newest first, before its score is resolved
 *  — landing-repo.ts's own return shape. See AircraftLanding below for the IPC-facing
 *  version Fleet actually receives. */
export interface AircraftLandingRow extends Landing {
  flightNumber: string | null
  depIcao: string
  arrIcao: string
}

/** Fleet's per-aircraft landing history, as sent over IPC. `score`/`severity` are resolved
 *  server-side (main/index.ts's fleetListLandings handler) against this aircraft's own
 *  wake category — never classified client-side, so Fleet and Logbook can't disagree about
 *  a landing. */
export interface AircraftLanding extends AircraftLandingRow {
  score: number
  severity: LandingSeverity
}

/**
 * Runway geometry for Logbook's touchdown diagram (docs/plans/logbook-detail-improvements.md)
 * — resolved in main from the flight's arrival airport plus the landing's own
 * `runwayIdent`, against the same vendored runway-lookup data `landing-capture.ts` measured
 * the stored `distanceFromThresholdM`/`centrelineOffsetM` against, so the diagram can never
 * disagree with the numbers shown next to it. Null (from `logbookGetLandingRunway`) when
 * the landing has no `runwayIdent`, or the matched runway end is missing the length/width/
 * aiming-point data the diagram needs — the same cases the card's own fields already show
 * as "—" for.
 */
export interface LandingRunway {
  ident: string
  lengthM: number
  widthM: number
  displacedThresholdM: number
  aimingPointDistanceM: number
}

export type LandingSeverity = 'none' | 'firm' | 'hard'

export type LandingScoreCategoryKey =
  'verticalSpeed' | 'gForce' | 'distanceFromAimingPoint' | 'centrelineOffset' | 'pitch' | 'bank' | 'crab'

/** One scored input's own 0-100 contribution (landing-score.ts's LandingScoreBreakdown,
 *  reshaped for the UI — see docs/decisions.md, 2026-09-12: Callum wanted a breakdown
 *  popup showing "why" a score is what it is). Null when this input had no runway match to
 *  score against (same null-handling as the stored landing fields themselves), never a
 *  fabricated number. `label` is decided server-side so the renderer doesn't keep its own
 *  copy of the key→label mapping. */
export interface LandingScoreCategory {
  key: LandingScoreCategoryKey
  label: string
  score: number | null
  /** What "perfect" and "score reaches 0" are for this category, in its own natural unit
   *  (fpm, degrees, g, or metres for the two runway-dependent ones) — real per-flight
   *  numbers for the runway-dependent categories, not a fixed constant, since they come
   *  from this specific runway's own real Annex-14/width data. Powers the breakdown
   *  popup's per-category info button (docs/decisions.md, 2026-09-12). Null exactly when
   *  `score` is null. */
  ideal: number | null
  tolerance: number | null
  /** distanceFromAimingPoint only — the real tolerance toward the threshold and away from it
   *  respectively, since that's the only category with two distinct real physical hard
   *  limits rather than one tolerance either side of `ideal` (shared/landing-score.ts's
   *  LandingScoreCategoryDetail, 2026-09-26). `tolerance` above still holds `toleranceLong`
   *  for any generic consumer. null for every other category, and null together with
   *  `tolerance` whenever this category has no runway match. */
  toleranceShort: number | null
  toleranceLong: number | null
  /** 0 when this category's own deviation stayed within tolerance; otherwise its own scaled
   *  danger penalty (1-10, further over tolerance scores higher, capped at 10 once the
   *  deviation reaches this category's own maxFraction of the dangerous value — 125% for
   *  most categories, 150% for crab specifically, since real testing showed the two need
   *  different ramps; shared/landing-score.ts's dangerPenaltyForFraction) already subtracted
   *  from `LandingScoreResult.score`. Lets the breakdown popup mark this category more
   *  strongly than the plain <50 "bad" warning every other poor score already gets, and show
   *  exactly how much it cost (docs/decisions.md, 2026-09-21). */
  dangerousPenalty: number
}

/** The 0-100 landing score plus its derived firm/hard classification — computed at read
 *  time from a stored landing's own fields (src/main/db/landing-score-resolver.ts), not
 *  stored itself, per docs/decisions.md (2026-09-12). No longer a Settings-configurable
 *  value — see @shared/landing-score for the per-aircraft-category baseline this derives
 *  from. `categories` backs the Logbook score-breakdown popup and the landing card's
 *  per-field warning icons. */
export interface LandingScoreResult {
  /** Floored at 0 for display — the underlying computeLandingScore can go negative
   *  internally once one or more categories' dangerousPenalty applies (landing-scoring-v2.md,
   *  2026-09-20; rescaled from a flat per-category deduction to a severity-scaled one,
   *  2026-09-21); flooring happens once, server-side (landing-score-resolver.ts), so every
   *  consumer of this field already sees the real display value. */
  score: number
  severity: LandingSeverity
  /** Each category's own `dangerousPenalty` (see LandingScoreCategory) is what's already
   *  baked into `score` above — there's no separate top-level list here since every
   *  category already carries its own answer to "was this one dangerous, and by how much". */
  categories: LandingScoreCategory[]
}

/** One flight's score, for Logbook's list-view column (docs/plans/landing-scoring.md's
 *  "Logbook UI" section) — omits any completed flight with no landing row (CSV-imported,
 *  or tracked before landing capture shipped), which the list shows as "—" for. `score` is
 *  against the *final* touchdown (winglog-backend's docs/plans/multiple-landings.md);
 *  `landingCount` backs the list's "×3" badge for a flight with more than one. */
export interface LandingScoreSummary {
  flightId: number
  score: number
  landingCount: number
}

/** One touchdown with its runway geometry and score already resolved server-side
 *  (winglog-backend's docs/plans/multiple-landings.md) — `logbookListLandings`'s own
 *  return shape, replacing the three separate logbookGetLanding/-Runway/-Score calls the
 *  Logbook detail page used to make per flight. `runway`/`score` are null under the same
 *  conditions the old per-call versions returned null for (no runwayIdent match, or
 *  nothing to score against). */
export interface LandingWithDetails extends Landing {
  runway: LandingRunway | null
  score: LandingScoreResult | null
}

/** One row for the Logbook Landings sub-tab (winglog-backend's docs/plans/
 *  multiple-landings.md Phase 2/3) — every touchdown across every non-deleted flight,
 *  joined with enough flight/aircraft context to sort and link back. Mirrors
 *  AircraftLandingRow's shape (which is scoped to one aircraft already); this one spans
 *  the whole fleet. */
export interface LandingListRow extends Landing {
  flightNumber: string | null
  aircraftRegistration: string
  depIcao: string
  arrIcao: string
  score: number | null
  severity: LandingSeverity | null
}

/** A landing as captured, before the database gives it an id. */
export type NewLanding = Omit<Landing, 'id'>
