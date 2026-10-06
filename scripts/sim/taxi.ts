/**
 * The taxi line and its re-routing, simulated on real taxis (flightdeck-backend
 * docs/plans/robustness/scenario-testing.md Part 6; done/taxi-reroute.md "Simulated").
 *
 * Each scenario is one real taxi: the clearance BeyondATC gave (its InfoBoxes, from main.log), the
 * recorded ground track from that moment, and the airport's cached network and stands. It runs
 * through the app's own steps: taxi-clearance.ts for the clearance and its line, and
 * taxiReroute.ts's trackPosition on every recorded position, as the Track map does.
 */
import type { BeyondAtcInfoBox, Flight, FlightPhase, NavdataStand, NavdataTaxiSegment, TrackPoint } from '../../src/shared/ipc'
import { findStand } from '../../src/shared/stands'
import { boxTaxiClearance, startOf, traceClearance, type TaxiClearance } from '../../src/renderer/src/taxi-clearance'
import { remainingRoute, type TracedRoute } from '../../src/renderer/src/taxiRouteTrace'
import { REROUTE_DISTANCE_M, REROUTE_MIN_SPEED_MS, startTracker, trackPosition } from '../../src/renderer/src/taxiReroute'
import type { LoggedInfoBoxes } from './local-data'

/** How long before off-blocks or after on-blocks a clearance still belongs to a flight, in ms. */
const FLIGHT_MARGIN_MS = 30 * 60_000

/** One recorded ground position. */
export interface GroundSample {
  tMs: number
  lat: number
  lon: number
  headingDeg: number
  groundSpeedMs: number
  phase: FlightPhase
}

export interface TaxiScenario {
  id: string
  flightId: number
  icao: string
  side: 'out' | 'in'
  /** When the clearance arrived, epoch ms. */
  atMs: number
  /** Where the clearance came from. */
  source: string
  boxes: BeyondAtcInfoBox[]
  /** A spoken "hold short of runway", which has no box. */
  holdShortRunway?: string | null
  /** Why this one can't be scored fairly, if it can't. */
  notScored?: string
  samples: GroundSample[]
}

/** A scenario written by hand, for taxis from before the boxes were logged (2026-10-05). */
export interface HandScenario {
  id: string
  flightId: number
  side: 'out' | 'in'
  /** An ISO time, or a point of the recorded taxi when it wasn't logged. */
  at: string | 'pushbackStart' | 'pushbackEnd' | 'vacated'
  source: string
  boxes: BeyondAtcInfoBox[]
  holdShortRunway?: string
  notScored?: string
}

/**
 * Phases as the current phase machine gives them: rows a pre-#108 bounce left in climb or cruise
 * on the ground were really taxi.
 */
function repairedPhase(point: TrackPoint): FlightPhase {
  return point.onGround && (point.phase === 'cruise' || point.phase === 'climb') ? 'taxi' : point.phase
}

/** A flight's ground positions on one side of the flight, oldest first. */
export function groundSamples(flight: Flight, points: TrackPoint[], side: 'out' | 'in'): GroundSample[] {
  const offMs = flight.actualOffUtc ? Date.parse(flight.actualOffUtc) : Number.POSITIVE_INFINITY
  const onMs = flight.actualOnUtc ? Date.parse(flight.actualOnUtc) : Number.POSITIVE_INFINITY
  return points
    .filter((p) => p.onGround && p.excludedReason === null)
    .map((p) => ({ p, tMs: Date.parse(p.tsUtc) }))
    .filter(({ tMs }) => (side === 'out' ? tMs < offMs : tMs > onMs))
    .map(({ p, tMs }) => ({ tMs, lat: p.latitude, lon: p.longitude, headingDeg: p.headingTrueDeg, groundSpeedMs: p.groundSpeedMs, phase: repairedPhase(p) }))
}

function flightAt(flights: Flight[], atMs: number): Flight | undefined {
  return flights.find((f) => {
    const out = f.actualOutUtc ? Date.parse(f.actualOutUtc) : null
    const end = f.actualInUtc ? Date.parse(f.actualInUtc) : out
    return out !== null && end !== null && atMs >= out - FLIGHT_MARGIN_MS && atMs <= end + FLIGHT_MARGIN_MS
  })
}

/**
 * The taxi clearances in the logged InfoBoxes, each matched to its flight. A clearance's taxi
 * runs until the next clearance on the same side of the same flight (a split clearance's first
 * half is scored only up to the second).
 */
export function scenariosFromLog(log: LoggedInfoBoxes[], flights: Flight[], pointsFor: (flightId: number) => TrackPoint[]): TaxiScenario[] {
  const found: Omit<TaxiScenario, 'samples' | 'id'>[] = []
  let lastKey = ''
  for (const entry of log) {
    const box = boxTaxiClearance(entry.boxes)
    if (!box) continue
    const flight = flightAt(flights, entry.atMs)
    if (!flight) continue
    const side = flight.actualOffUtc && entry.atMs < Date.parse(flight.actualOffUtc) ? 'out' : 'in'
    const key = `${flight.id}|${side}|${JSON.stringify(box)}`
    if (key === lastKey) continue
    lastKey = key
    const icao = side === 'out' ? flight.depIcao : flight.arrIcao
    if (!icao) continue
    found.push({ flightId: flight.id, icao, side, atMs: entry.atMs, source: 'logged InfoBoxes', boxes: entry.boxes })
  }
  return found.map((sc, i) => {
    const next = found.slice(i + 1).find((o) => o.flightId === sc.flightId && o.side === sc.side)
    const flight = flights.find((f) => f.id === sc.flightId) as Flight
    const samples = groundSamples(flight, pointsFor(sc.flightId), sc.side).filter((s) => s.tMs >= sc.atMs && (!next || s.tMs < next.atMs))
    const part = found.filter((o) => o.flightId === sc.flightId && o.side === sc.side).indexOf(sc)
    return { ...sc, id: `${sc.flightId}-${sc.side}${part > 0 ? `-${part + 1}` : ''}`, samples }
  })
}

/** A hand-written scenario, with its time resolved against the recorded taxi. */
export function scenarioFromHand(hand: HandScenario, flight: Flight, points: TrackPoint[]): TaxiScenario | null {
  const all = groundSamples(flight, points, hand.side)
  const resolve: Record<string, () => number | undefined> = {
    pushbackStart: () => all.find((s) => s.phase === 'pushback')?.tMs,
    pushbackEnd: () => all.find((s) => s.phase === 'taxi')?.tMs,
    vacated: () => all.find((s) => s.groundSpeedMs < 15)?.tMs
  }
  const atMs = resolve[hand.at]?.() ?? Date.parse(hand.at)
  const icao = hand.side === 'out' ? flight.depIcao : flight.arrIcao
  if (Number.isNaN(atMs) || !icao) return null
  return { ...hand, icao, atMs, samples: all.filter((s) => s.tMs >= atMs) }
}

/** One re-route: where the aircraft was and the line before and after. */
export interface Reroute {
  tMs: number
  at: { lat: number; lon: number }
  headingDeg: number
  before: TracedRoute
  after: TracedRoute
}

export interface TaxiRun {
  /** The line drawn when the clearance arrived; null when it couldn't be traced. */
  cleared: TracedRoute | null
  clearance: TaxiClearance | null
  stand: NavdataStand | null
  reroutes: Reroute[]
  /** Share of moving taxi samples within REROUTE_DISTANCE_M of the line shown, 0-100. */
  onLinePct: number | null
  /** Closest the line's end came to the aircraft, in metres. */
  endToAircraftM: number | null
}

const M_PER_DEG = 111_320

function metres(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  return Math.hypot((a.lat - b.lat) * M_PER_DEG, (a.lon - b.lon) * M_PER_DEG * Math.cos((a.lat * Math.PI) / 180))
}

/** The clearance as the app takes it, at the first recorded position. */
function clearanceFor(sc: TaxiScenario): TaxiClearance | null {
  const box = boxTaxiClearance(sc.boxes)
  const first = sc.samples[0]
  if (!box || !first) return null
  return { ...box, holdShortRunway: box.holdShortRunway ?? sc.holdShortRunway ?? null, ...startOf(first) }
}

/**
 * Plays one taxi through the app's steps. With `reroute` false, the line never re-routes: the
 * behaviour before taxi-reroute.md, for comparison.
 */
export function runTaxi(sc: TaxiScenario, segments: NavdataTaxiSegment[], stands: NavdataStand[], reroute: boolean): TaxiRun {
  const clearance = clearanceFor(sc)
  const stand = clearance?.stand ? findStand(stands, clearance.stand) : null
  const cleared = clearance ? traceClearance(clearance, segments, stand) : null
  if (!clearance || !cleared) return { cleared, clearance, stand, reroutes: [], onLinePct: null, endToAircraftM: null }

  let tracker = startTracker(cleared)
  let drawn: TracedRoute = cleared
  const reroutes: Reroute[] = []
  let moving = 0
  let onLine = 0
  for (const s of sc.samples) {
    if (s.phase === 'takeoff') break
    const update = trackPosition(tracker, { position: s, phase: s.phase, nowMs: s.tMs, segments: reroute ? segments : undefined })
    tracker = update.tracker
    if (update.rerouted) reroutes.push({ tMs: s.tMs, at: { lat: s.lat, lon: s.lon }, headingDeg: s.headingDeg, before: drawn, after: update.line })
    drawn = update.line
    if (s.phase === 'taxi' && !tracker.done && s.groundSpeedMs > REROUTE_MIN_SPEED_MS) {
      moving++
      if (remainingRoute(tracker.active, s, 0).distanceM <= REROUTE_DISTANCE_M) onLine++
    }
  }
  const end = tracker.active.at(-1)
  const endToAircraftM = end ? Math.min(...sc.samples.map((s) => metres({ lat: end[1], lon: end[0] }, s))) : null
  return { cleared, clearance, stand, reroutes, onLinePct: moving > 0 ? Math.round((100 * onLine) / moving) : null, endToAircraftM }
}
