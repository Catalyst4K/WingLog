import type { Landing, LandingScoreCategory, LandingScoreCategoryKey, LandingScoreResult, LandingScoreSummary } from '@shared/ipc'
import {
  classifyLanding,
  computeLandingScore,
  deriveLandingThresholds,
  type LandingScoreBreakdown,
  type LandingScoreInputs
} from '@shared/landing-score'
import { getWakeCategory } from '../aircraft-lookup/icao-types'
import { FALLBACK_LATERAL_TOLERANCE_M, findRunwayEndByIdent } from '../airports/runway-lookup'
import { getAircraftById } from './aircraft-repo'
import type { WingLogDb } from './client'
import { listCompletedFlights } from './flight-repo'
import { listLandingsByFlight } from './landing-repo'

// Order matches the landing card's own field order (touchdown rate, G-force, pitch, bank,
// crab, then the two runway-dependent inputs) — the breakdown popup and the card's warning
// icons both read top-to-bottom the same way the raw fields already do.
const CATEGORY_LABELS: Record<LandingScoreCategoryKey, string> = {
  verticalSpeed: 'Vertical speed',
  gForce: 'G-force',
  pitch: 'Pitch',
  bank: 'Bank',
  crab: 'Crab',
  distanceFromAimingPoint: 'Distance from aiming point',
  centrelineOffset: 'Centreline offset'
}

function toCategories(breakdown: LandingScoreBreakdown): LandingScoreCategory[] {
  const keys: LandingScoreCategoryKey[] = [
    'verticalSpeed',
    'gForce',
    'pitch',
    'bank',
    'crab',
    'distanceFromAimingPoint',
    'centrelineOffset'
  ]
  return keys.map((key) => {
    const detail = breakdown.details[key]
    return {
      key,
      label: CATEGORY_LABELS[key],
      score: breakdown.inputs[key],
      ideal: detail?.ideal ?? null,
      tolerance: detail?.tolerance ?? null
    }
  })
}

/**
 * Assembles a stored landing's real, already-vendored context (the aircraft's wake
 * category, and its runway end for the aiming-point/centreline inputs) into
 * computeLandingScore's inputs, and pairs that with the derived firm/hard classification —
 * see landing-score.ts and docs/decisions.md (2026-09-12) for the design this implements.
 * `icaoType` is the owning aircraft's `icao_type` — null only for a landing whose aircraft
 * has since been deleted (a genuine, if rare, orphan), in which case the score falls back
 * to the M baseline like any other unrecognised type.
 */
export function resolveLandingScore(
  landingRecord: Landing,
  arrIcao: string,
  icaoType: string | null
): LandingScoreResult {
  const category = icaoType ? getWakeCategory(icaoType) : null
  const runwayEnd = landingRecord.runwayIdent ? findRunwayEndByIdent(arrIcao, landingRecord.runwayIdent) : null

  const aimingPointToleranceM = runwayEnd?.aimingPointDistanceM ?? null
  const centrelineToleranceM = runwayEnd
    ? runwayEnd.widthM !== null
      ? runwayEnd.widthM / 2
      : FALLBACK_LATERAL_TOLERANCE_M
    : null

  const inputs: LandingScoreInputs = {
    category,
    verticalSpeedMs: landingRecord.verticalSpeedMs,
    gForce: landingRecord.gForce,
    pitchDeg: landingRecord.pitchDeg,
    bankDeg: landingRecord.bankDeg,
    crabDeg: landingRecord.crabDeg,
    distanceFromAimingPointM:
      landingRecord.distanceFromThresholdM !== null && aimingPointToleranceM !== null
        ? landingRecord.distanceFromThresholdM - aimingPointToleranceM
        : null,
    runwayLengthM: landingRecord.distanceFromThresholdM !== null ? (runwayEnd?.lengthM ?? null) : null,
    centrelineOffsetM: landingRecord.centrelineOffsetM,
    centrelineToleranceM: landingRecord.centrelineOffsetM !== null ? centrelineToleranceM : null
  }

  const breakdown = computeLandingScore(inputs)
  const severity = classifyLanding(landingRecord.verticalSpeedMs, deriveLandingThresholds(category))
  return { score: breakdown.overall, severity, categories: toCategories(breakdown) }
}

/**
 * Logbook's list-view score column (docs/plans/landing-scoring.md's "Logbook UI" section)
 * — one summary per completed flight that actually has a landing row; a CSV-imported
 * flight or one tracked before landing capture shipped simply isn't in the result, so the
 * list shows "—" for those rather than a fabricated score. Deliberately not one query with
 * every join inlined — completed-flights-with-a-landing is a small, bounded set, and
 * reusing the existing repo functions here keeps this in step with them automatically.
 *
 * Scores against the *final* touchdown (flightdeck-backend's docs/plans/
 * multiple-landings.md) — the one that ended the flight, matching LandingCard's own
 * default — with `landingCount` alongside it so the list can show a "×3" badge for a flight
 * with several without a second round trip.
 */
export function getLandingScoresForCompletedFlights(db: WingLogDb): LandingScoreSummary[] {
  const icaoTypeByAircraftId = new Map<number, string | null>()
  const summaries: LandingScoreSummary[] = []

  for (const f of listCompletedFlights(db)) {
    const landings = listLandingsByFlight(db, f.id)
    if (landings.length === 0) continue
    const finalLanding = landings[landings.length - 1]

    // A free flight tracked with no fleet aircraft has no aircraftId to look up — its own
    // simIcaoType (the sim-reported type, recorded at free-flight start) stands in instead.
    let icaoType: string | null
    if (f.aircraftId != null) {
      if (!icaoTypeByAircraftId.has(f.aircraftId)) {
        icaoTypeByAircraftId.set(f.aircraftId, getAircraftById(db, f.aircraftId)?.icaoType ?? null)
      }
      icaoType = icaoTypeByAircraftId.get(f.aircraftId) ?? null
    } else {
      icaoType = f.simIcaoType
    }
    const icao = finalLanding.icao ?? f.arrIcao
    const { score } = resolveLandingScore(finalLanding, icao, icaoType)
    summaries.push({ flightId: f.id, score, landingCount: landings.length })
  }

  return summaries
}
