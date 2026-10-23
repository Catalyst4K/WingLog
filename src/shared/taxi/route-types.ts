/**
 * What a taxi trace is asked and answers (winglog-backend's docs/plans/taxi-routing-rules.md): the request, the route, the runway as a
 * strip, and the limits and costs the trace, the fallback and the checks share.
 */

import type { NavdataTaxiSegment } from '@shared/ipc'
import type { RunwayThreshold } from './runway-hold'

/** What joining the clearance at a later taxiway costs, for each one skipped at its start. An aircraft that can only drive the first
 *  one by a loop joins at the next instead: YBBN flight 225 pushed back facing away from C9, and the line went past B9 and round the
 *  block by C8 to come back down C9, where Callum took C10 and B straight to B9. A first taxiway within reach is still driven. */
export const SKIP_COST_M = 500
/** A cleared taxi route longer than this is almost certainly a wrong trace, not a real one. */
export const MAX_ROUTE_LENGTH_M = 15_000
/** More taxiways than this is not a clearance: ATC's longest in the 23 recorded taxis names 5, and the trace's search grows with the list. */
export const MAX_CLEARANCE_TAXIWAYS = 20
/**
 * How many search states one trace may take from the queue, all its searches together. The recorded taxis need up to 39,828 (a flown EGLL
 * clearance, 418 ms); a clearance that cannot be resolved on RKSI's 16,000 segments searched 109,489 (1 s) before giving up. The budget
 * bounds that second kind; it does not make the first fast.
 */
export const MAX_TRACE_STATES = 60_000
/** How near the cleared runway's threshold a holding point's hold short is for the runway to say anything about it. A first hold short
 *  farther than this is replaced by the one nearest the threshold, when there is one this near; none this near (an intersection
 *  departure's holding point), or the first already this near, and the first stays. */
export const MAX_HOLD_FROM_THRESHOLD_M = 500
/** When no hold short of the holding-point taxiway is near the cleared runway's threshold, any flagged hold short this near it ends the route
 *  (WSSS "taxi holding point runway 02C via P, T": T has no flagged points, and the holding point is on its T12 branch). */
export const HOLD_NEAR_THRESHOLD_M = 250

/** A runway as a strip on the ground: where it starts, which way it runs, how long and wide. */
export interface RunwayStrip {
  thresholdLat: number
  thresholdLon: number
  headingTrueDeg: number
  lengthM: number
  widthM: number
}

export interface TaxiTraceRequest {
  segments: NavdataTaxiSegment[]
  /** The cleared taxiways, in order, as ATC said them ("via B8, B" → ['B8', 'B']). */
  taxiways: string[]
  /** "holding point B10" → 'B10'; null for a stand clearance. */
  holdingPoint: string | null
  from: { lat: number; lon: number }
  /** A stand clearance's stand, positioned (the `Taxi to Gate` box + the sim's
   *  stands); ignored for a holding-point clearance. */
  stand?: { lat: number; lon: number } | null
  /** The cleared runway's threshold ("taxi to holding point A, runway 05L"). A taxiway running along a runway has a hold short at each
   *  of its entries; the holding point is the one by this threshold, not whichever the search reaches first. Ignored when none is
   *  near it. */
  runwayThreshold?: RunwayThreshold | null
  /** A hold short the route must end at: the furthest-back one beside the cleared runway (see taxi-runway-hold.ts). */
  holdAt?: { lat: number; lon: number } | null
  /** The aircraft's true heading, when it's taxiing under its own power. A first edge pointing
   *  more than WRONG_WAY_DEG away from it costs an extra WRONG_WAY_PENALTY_M, so the
   *  route starts forwards; a U-turn is still taken when it's the only way (dead-end stand
   *  rows). Null or absent: no preference. */
  headingDeg?: number | null
  /** The runway of a "hold short of runway 34R" clearance. The route ends at the first hold short beside it, which can be on
   *  another taxiway than the last cleared one (RKSI flight 239: "via P8, P, hold short of 34R", crossing at P9, not at P's far
   *  end 1.5 km on). */
  holdShortRunway?: RunwayStrip | null
  /** Ends a "hold short of runway" route only at a hold short beside that runway, not at the first hold short of the last taxiway.
   *  Set by the first try; the second drops it for scenery with no hold short beside the runway. */
  onlyAtRunwayHold?: boolean
  /** With onlyAtRunwayHold, ends only where the route crosses the runway (taxi-runway-crossing.ts), not at a hold short on an exit. */
  crossingOnly?: boolean
  /** The states left for the searches of this trace (MAX_TRACE_STATES when absent), shared by them all. Callers set it to share one budget
   *  between the trace and its fallback; the searches count it down. */
  budget?: { left: number }
}

/** [lon, lat] pairs, GeoJSON order, from the aircraft's nearest network point to the hold. */
export type TracedRoute = [number, number][]
