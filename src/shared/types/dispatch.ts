/** Dispatch: a fetched SimBrief OFP and the parameters for opening SimBrief. */

import type { SimBriefOfp, SimBriefStepClimb } from '../simbrief-ofp'

/** One navlog fix of a fetched OFP. */
export type DispatchWaypoint = SimBriefOfp['waypoints'][number]

/** A planned mid-cruise altitude increase — see parseStepClimbs in simbrief-ofp.ts. */
export type DispatchStepClimb = SimBriefStepClimb

/**
 * A freshly-fetched OFP, not yet saved as a Flight — the renderer confirms/picks the aircraft
 * first. The parsed OFP as sent over IPC: `rawJson` travels as `ofpJson`, the name a stored
 * Flight uses.
 */
export interface DispatchOfp extends Omit<SimBriefOfp, 'rawJson'> {
  ofpJson: string
  /** Fleet aircraft whose registration matches `aircraftRegistration`, if any. */
  matchedAircraftId: number | null
}

/**
 * A departure time to prefill on SimBrief's form, already split into the shape its input
 * parameters want (docs/simbrief-notes.md, 2026-09-02 spike): `date` is midnight UTC of
 * the departure day in epoch seconds, `hour`/`minute` are plain UTC integers.
 * `src/renderer/src/dispatch-time.ts` computes this from a `Date` — a wrong-format date
 * is silently misread by SimBrief (yields a 1970 departure) rather than rejected, so it's
 * computed here, never passed through from free text.
 */
export interface DispatchDeparture {
  dateEpochSeconds: number
  hour: number
  minute: number
}

/**
 * Opens SimBrief's dispatch form pre-filled with a route and airframe. `simbriefAirframeId`
 * takes priority over `icaoType` when set (SimBrief uses the saved custom profile);
 * otherwise SimBrief falls back to its own default airframe for that type — WingLog
 * doesn't need to implement that fallback itself. `airlineIcao`/`flightNumber`/`departure`
 * are optional prefills added on top of the original orig/dest/airframe set (docs/decisions.md,
 * SimBrief-generation entry) — each is only appended to the URL when present, so leaving
 * them unset reproduces the original URL exactly.
 */
export interface DispatchOpenSimBriefParams {
  origIcao: string
  destIcao: string
  icaoType: string
  simbriefAirframeId: string | null
  /** A chosen SimBrief default type (aircraft.simbrief_type) — takes priority over
   *  icaoType for the `type=` fallback when there's no simbriefAirframeId, per
   *  docs/decisions.md's fleet-simbrief-airframe entry. */
  simbriefType?: string | null
  airlineIcao?: string | null
  flightNumber?: string | null
  departure?: DispatchDeparture | null
  /** Advanced options from src/shared/dispatch-options.ts, already reduced to
   *  `[paramName, value]` pairs with unset fields omitted — computed in the renderer
   *  (where it's unit-tested) rather than re-derived here, so this handler stays a plain
   *  pass-through. */
  extra?: [string, string][]
}
