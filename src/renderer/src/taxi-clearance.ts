/**
 * A BeyondATC taxi clearance and the line drawn for it: the pure steps of the Track map's taxi
 * route (useTaxiRouteHighlight.ts), shared with the simulation (scripts/sim/taxi.sim.ts) so it
 * runs the app's own code (winglog-backend docs/plans/robustness/scenario-testing.md Part 6).
 */
import type { BeyondAtcInfoBox, NavdataStand, NavdataTaxiSegment } from '@shared/ipc'
import { parseAtcTaxiFacts } from '@shared/atc-info-boxes'
import { traceTaxiRoute, type TracedRoute } from './taxiRouteTrace'

export interface TaxiClearance {
  taxiways: string[]
  holdingPoint: string | null
  /** "taxi to Stand N32 …" → 'N32'; null for a holding-point clearance. */
  stand: string | null
  /** "taxi via C7, Y, F, hold short of runway 07C" → '07C': the route runs along its last
   *  taxiway to the hold short, the same way as a holding point. */
  holdShortRunway: string | null
  /** Where the aircraft was when the clearance arrived — the trace's start. The line follows
   *  the clearance from there whichever way the aircraft faces: if it's driven the other way,
   *  the re-route takes over (YBBN flight 225, Callum 2026-10-06). */
  from: { lat: number; lon: number } | null
}

/** "27L" or "09": a `Hold Position` box naming a runway, not a holding point. */
const RUNWAY_IDENT = /^\d{1,2}[LRC]?$/

/**
 * The taxi clearance in BeyondATC's InfoBoxes (winglog-backend's
 * docs/plans/beyondatc-infoboxes-first.md): `Taxi Via 1..n`, `Hold Position`, `Taxi to Gate`.
 * Real, 2026-10-05: VHHH "B, B, V, H, J" to J1 and ZJSY "A4, D" to gate 102. Null when the
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
  return {
    taxiways: facts.taxiVia,
    holdingPoint: holdIsRunway ? null : hold,
    stand: facts.taxiToGate,
    holdShortRunway: holdIsRunway ? hold : null
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
    for (const s of (icao && segmentsByIcao[icao]) || []) {
      const distance = Math.hypot(s.startLat - from.lat, (s.startLon - from.lon) * Math.cos((from.lat * Math.PI) / 180))
      if (!best || distance < best.distance) best = { icao: icao!, distance }
    }
  }
  return best?.icao ?? arrIcao
}

/**
 * A clearance's start: the aircraft's position.
 *
 * @param position The aircraft's position, or null.
 * @returns The clearance's start.
 */
export function startOf(position: { lat: number; lon: number } | null): Pick<TaxiClearance, 'from'> {
  return { from: position ? { lat: position.lat, lon: position.lon } : null }
}

/**
 * The line for a clearance, from where the aircraft was when it arrived: to the holding point,
 * along the last taxiway to a runway's hold short, or to the stand. Null when it can't be traced.
 *
 * @param clearance The clearance.
 * @param segments The airport's taxi network.
 * @param stand The cleared stand, or null.
 * @returns The traced line, or null.
 */
export function traceClearance(
  clearance: TaxiClearance,
  segments: NavdataTaxiSegment[],
  stand: NavdataStand | null
): TracedRoute | null {
  if (!clearance.from) return null
  return traceTaxiRoute({
    segments,
    taxiways: clearance.taxiways,
    holdingPoint: clearance.holdingPoint ?? (clearance.holdShortRunway ? (clearance.taxiways.at(-1) ?? null) : null),
    from: clearance.from,
    stand
  })
}
