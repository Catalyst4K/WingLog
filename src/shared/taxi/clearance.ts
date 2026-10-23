/**
 * A BeyondATC taxi clearance and the line drawn for it: the pure steps of the Track map's taxi
 * route (use-taxi-route-highlight.ts), shared with the simulation (scripts/sim/taxi.sim.ts) so it
 * runs the app's own code (winglog-backend docs/plans/robustness/scenario-testing.md Part 6).
 */
import type { BeyondAtcInfoBox, NavdataRunway, NavdataStand, NavdataTaxiSegment } from '@shared/ipc'
import { parseAtcTaxiFacts } from '@shared/atc-info-boxes'
import { findStand } from '@shared/stands'
import { traceWithFallback, type TracedClearance } from './fallback'
import type { RunwayStrip, TaxiTraceRequest, TracedRoute } from './route-types'
import { aliasSplitTaxiways } from './name-alias'
import type { RunwayThreshold } from './runway-hold'

export interface TaxiClearance {
  taxiways: string[]
  holdingPoint: string | null
  /** "taxi to Stand N32 …" → 'N32'; null for a holding-point clearance. */
  stand: string | null
  /** "taxi via C7, Y, F, hold short of runway 07C" → '07C': the route runs along its last
   *  taxiway to the hold short, the same way as a holding point. */
  holdShortRunway: string | null
  /** "taxi to holding point A, runway 05L" → '05L' (the `Taxi to Runway` box): the runway the holding point is for. */
  taxiToRunway?: string | null
  /** Where the aircraft was when the clearance arrived — the trace's start — and which way its nose pointed: the line starts that
   *  way (in 22 of Callum's 23 recorded taxis the aircraft moved off that way; the other was mid-pushback, nose still pointing the
   *  way it would taxi). If it's driven the other way, the re-route takes over. */
  from: { lat: number; lon: number; headingDeg?: number } | null
}

/** "27L" or "09": a `Hold Position` box naming a runway, not a holding point. */
const RUNWAY_IDENT = /^\d{1,2}[LRC]?$/

/**
 * The taxi clearance in BeyondATC's InfoBoxes (winglog-backend's
 * docs/plans/beyondatc-infoboxes-first.md): `Taxi Via 1..n`, `Hold Position`, `Taxi to Gate`.
 * For example VHHH "B, B, V, H, J" to J1 and ZJSY "A4, D" to gate 102. Null when the
 * boxes hold no taxi route.
 *
 * @param boxes One set of InfoBoxes.
 * @returns The clearance, or null.
 */
export function boxTaxiClearance(boxes: BeyondAtcInfoBox[]): Omit<TaxiClearance, 'from'> | null {
  const facts = parseAtcTaxiFacts(boxes)
  if (facts.taxiVia.length === 0) return null
  const hold = facts.holdPosition
  const holdIsRunway = hold !== null && RUNWAY_IDENT.test(hold)
  // "taxi holding point runway 02C via P, T" arrives with only the Taxi to Runway and Taxi Via boxes (WSSS 2026-10-19): the holding point
  // is then the last taxiway's hold short beside that runway's threshold.
  const toRunwayOnly = hold === null && !facts.holdShort && !facts.taxiToGate && facts.taxiToRunway !== null
  return {
    taxiways: facts.taxiVia,
    holdingPoint: holdIsRunway ? null : (hold ?? (toRunwayOnly ? (facts.taxiVia.at(-1) ?? null) : null)),
    stand: facts.taxiToGate,
    holdShortRunway: holdIsRunway ? hold : facts.holdShort,
    taxiToRunway: facts.taxiToRunway
  }
}

/**
 * Which airport a clearance is at: a holding point is the departure's, a stand the arrival's.
 * "Hold short of runway" can be either (crossing a runway on the way out, or on the way in as
 * at VHHH), so it's the one whose taxi network is nearest the aircraft; the arrival if
 * neither is loaded yet.
 *
 * @param clearance The clearance.
 * @param depIcao The departure airport.
 * @param arrIcao The arrival airport.
 * @param segmentsByIcao The taxi networks loaded so far.
 * @returns The airport, or null.
 */
export function clearanceAirport(
  clearance: TaxiClearance,
  depIcao: string | null,
  arrIcao: string | null,
  segmentsByIcao: Record<string, NavdataTaxiSegment[]>
): string | null {
  if (clearance.holdingPoint) return depIcao
  if (!clearance.holdShortRunway || !clearance.from) return arrIcao
  const from = clearance.from
  let best: { icao: string; distance: number } | null = null
  for (const icao of [arrIcao, depIcao]) {
    if (!icao) continue
    for (const s of segmentsByIcao[icao] ?? []) {
      const distance = Math.hypot(
        s.startLat - from.lat,
        (s.startLon - from.lon) * Math.cos((from.lat * Math.PI) / 180)
      )
      if (!best || distance < best.distance) best = { icao, distance }
    }
  }
  return best?.icao ?? arrIcao
}

/**
 * A clearance's start: the aircraft's position, and its heading when known.
 *
 * @param position The aircraft's position and heading (degrees true), or null.
 * @returns The clearance's start.
 */
export function startOf(
  position: { lat: number; lon: number; headingDeg?: number } | null
): Pick<TaxiClearance, 'from'> {
  if (!position) return { from: null }
  const { lat, lon, headingDeg } = position
  return { from: typeof headingDeg === 'number' ? { lat, lon, headingDeg } : { lat, lon } }
}

/**
 * The threshold of the runway a holding-point clearance is for, from an airport's runways: "05L" and "5L" name the same runway.
 *
 * @param taxiToRunway The clearance's runway (the `Taxi to Runway` box), null for a clearance with no holding point or none named.
 * @param runways The airport's runways, each with its threshold.
 * @returns The threshold, or null when no runway is named or it is not among them.
 */
export function clearanceRunwayThreshold(
  taxiToRunway: string | null | undefined,
  runways: { ident: string; thresholdLat: number; thresholdLon: number; headingTrueDeg?: number }[]
): RunwayThreshold | null {
  const runway = clearanceRunway(taxiToRunway, runways)
  if (!runway) return null
  const threshold = { lat: runway.thresholdLat, lon: runway.thresholdLon }
  return runway.headingTrueDeg === undefined ? threshold : { ...threshold, headingDeg: runway.headingTrueDeg }
}

/**
 * A cleared runway from an airport's runways: "05L" and "5L" name the same runway.
 *
 * @param ident The runway the clearance names, or null.
 * @param runways The airport's runways.
 * @returns The runway, or null when none is named or it is not among them.
 */
export function clearanceRunway<R extends { ident: string }>(
  ident: string | null | undefined,
  runways: R[]
): R | null {
  if (!ident) return null
  const key = (name: string): string => name.replace(/^0+/, '').toUpperCase()
  return runways.find((r) => key(r.ident) === key(ident)) ?? null
}

/** Where a clearance ends, as the trace needs to know it. */
export interface ClearanceEnds {
  /** The cleared stand, positioned, or null. */
  stand: NavdataStand | null
  /** The threshold of the runway a holding-point clearance is for, or null. */
  threshold: RunwayThreshold | null
  /** The runway of a "hold short of runway" clearance, or null. */
  holdShortRunway: RunwayStrip | null
}

/**
 * Where a clearance ends, as far as the stands and runways known say: its stand, the threshold of the runway of a holding point, or the
 * runway of a hold short. The one place that works it out: the taxi line service, the offline simulations and the test suite all use it,
 * so none of them can end a clearance differently from the app.
 *
 * @param clearance The clearance.
 * @param stands The clearance airport's stands.
 * @param runways The clearance airport's runways.
 * @returns What the trace needs to know of the end; each null when the clearance has none or the data lacks it.
 */
export function clearanceEnds(
  clearance: TaxiClearance,
  stands: NavdataStand[],
  runways: NavdataRunway[]
): ClearanceEnds {
  return {
    stand: clearance.stand ? findStand(stands, clearance.stand) : null,
    threshold: clearance.holdingPoint ? clearanceRunwayThreshold(clearance.taxiToRunway, runways) : null,
    holdShortRunway: clearance.holdingPoint ? null : clearanceRunway(clearance.holdShortRunway, runways)
  }
}

/**
 * The line for a clearance, from where the aircraft was when it arrived: to the holding point,
 * along the last taxiway to a runway's hold short, or to the stand. Null when it can't be traced.
 *
 * @param clearance The clearance.
 * @param segments The airport's taxi network.
 * @param stand The cleared stand, or null.
 * @param runwayThreshold The threshold of the runway a holding point is for, or null.
 * @param holdShortRunway The runway of a "hold short of runway" clearance, or null.
 * @returns The traced line, or null.
 */
export function traceClearance(
  clearance: TaxiClearance,
  segments: NavdataTaxiSegment[],
  stand: NavdataStand | null,
  runwayThreshold: RunwayThreshold | null = null,
  holdShortRunway: RunwayStrip | null = null
): TracedRoute | null {
  return traceClearanceDetailed(clearance, segments, stand, runwayThreshold, holdShortRunway)?.route ?? null
}

/**
 * The line for a clearance as traceClearance gives it, with how it was made (traced through the cleared taxiways, or found by the
 * pathfinder when that fails) and how well it matches the clearance.
 *
 * @param clearance The clearance.
 * @param segments The airport's taxi network.
 * @param stand The cleared stand, or null.
 * @param runwayThreshold The threshold of the runway a holding point is for, or null.
 * @param holdShortRunway The runway of a "hold short of runway" clearance, or null.
 * @returns The line, how it was made and its match; null when neither way works.
 */
export function traceClearanceDetailed(
  clearance: TaxiClearance,
  segments: NavdataTaxiSegment[],
  stand: NavdataStand | null,
  runwayThreshold: RunwayThreshold | null = null,
  holdShortRunway: RunwayStrip | null = null
): TracedClearance | null {
  const request = clearanceRequest(clearance, segments, stand, runwayThreshold, holdShortRunway)
  return request && traceWithFallback(request)
}

/**
 * What a clearance asks of the trace: the cleared taxiways, where it ends, and where the aircraft starts.
 *
 * @param clearance The clearance.
 * @param segments The airport's taxi network.
 * @param stand The cleared stand, or null.
 * @param runwayThreshold The threshold of the runway a holding point is for, or null.
 * @param holdShortRunway The runway of a "hold short of runway" clearance, or null.
 * @returns The request, or null before the aircraft's position is known.
 */
export function clearanceRequest(
  clearance: TaxiClearance,
  segments: NavdataTaxiSegment[],
  stand: NavdataStand | null,
  runwayThreshold: RunwayThreshold | null = null,
  holdShortRunway: RunwayStrip | null = null
): TaxiTraceRequest | null {
  if (!clearance.from) return null
  const holdingPoint =
    clearance.holdingPoint ?? (clearance.holdShortRunway ? (clearance.taxiways.at(-1) ?? null) : null)
  return {
    // A taxiway the sim splits into numbered pieces (ZUCK's M is M1 to M4) is followed by those.
    segments: aliasSplitTaxiways(
      segments,
      holdingPoint ? [...clearance.taxiways, holdingPoint] : clearance.taxiways
    ),
    taxiways: clearance.taxiways,
    holdingPoint,
    from: { lat: clearance.from.lat, lon: clearance.from.lon },
    headingDeg: clearance.from.headingDeg ?? null,
    stand,
    runwayThreshold: clearance.holdingPoint ? runwayThreshold : null,
    holdShortRunway: clearance.holdingPoint ? null : holdShortRunway
  }
}
