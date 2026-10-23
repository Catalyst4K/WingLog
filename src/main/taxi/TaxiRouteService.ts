/**
 * The taxi line, traced once in the main process and pushed to every screen as the `taxiRoute` topic (winglog-backend's
 * docs/plans/taxi-and-second-screen-robustness.md, stage 3). Before this each screen traced it for itself, only while its own taxi chart
 * was on and its page open, so the PC window and a phone could draw different lines, and a phone that was locked when the clearance came
 * drew none.
 *
 * It follows BeyondATC's InfoBoxes and the aircraft's position on the live hub, never a screen. A new clearance is traced (traceWithFallback:
 * the traced line, else the shortest way, else nothing) and then followed sample by sample (trackPosition), which shortens the line as the
 * aircraft taxis and re-routes it when the aircraft leaves it. A trace runs only when something it depends on changes (a new clearance, the
 * aircraft's first position, a refreshed taxi network, the stands arriving), never per sample: it can take hundreds of milliseconds on a big
 * airport. Both searches, the trace and a re-route, run on the app's worker thread (winglog-backend docs/plans/reroute-worker.md); the line
 * keeps following the old route until a re-route's answer comes back.
 */

import type { BeyondAtcState, FlightPhase, NavdataStand, NavdataTaxiSegment, SimTelemetry } from '@shared/ipc'
import type { LiveTopic, LiveTopics, TaxiRoute } from '@shared/live'
import { clearanceAirport, clearanceEnds, startOf, type TaxiClearance } from '@shared/taxi/clearance'
import { INITIAL_TAXI_MEMORY, isDeparted, stepTaxiBoxes, type TaxiMemory } from '@shared/taxi/clearance-step'
import type { TracedClearance } from '@shared/taxi/fallback'
import { applyReroute, followPosition, startTracker, type RerouteTracker } from '@shared/taxi/reroute'
import type { RejoinRequest } from '@shared/taxi/route-rejoin'
import { logger } from '../logging/logger'
import type { LiveHub } from '../live/LiveHub'
import type { ShownFlight } from '../navdata/flight-navdata-fetcher'
import type { SimFacilitiesProvider } from '../navdata/sim-facilities-provider'
import { rejoinInline, traceInline, type RejoinRunner, type TraceJob, type TraceRunner } from './trace-runner'
import type { RunwayStrip, TracedRoute } from '@shared/taxi/route-types'

/** What the service needs from the rest of the app. */
export interface TaxiRouteServiceDeps {
  hub: Pick<LiveHub, 'publish' | 'subscribe' | 'snapshot'>
  navdata: Pick<SimFacilitiesProvider, 'getTaxiNetwork' | 'listRunways' | 'getStands' | 'onAirportRefreshed'>
  /** The planned or tracked flight, for the airports a clearance can be for. */
  shownFlight(): ShownFlight | undefined
  /** The flight being tracked and its phase, or undefined when none is. */
  active(): { flightId: number; phase: FlightPhase } | undefined
  now(): number
  /** Traces a clearance. Inline when absent; the app gives it a worker thread, so a slow trace never holds up the main process. */
  trace?: TraceRunner
  /** Re-routes the line. Inline when absent; the app gives it the same worker thread. */
  rejoin?: RejoinRunner
}

/** Following the line slower than this is logged, once per clearance: it runs on every sample, in the process that also talks to the sim. */
const SLOW_TRACK_MS = 20

type Position = { lat: number; lon: number; headingDeg: number; groundSpeedMs: number }

/**
 * @param t A telemetry sample.
 * @returns Where the aircraft is, which way it points and how fast it moves.
 */
function positionOf(t: SimTelemetry): Position {
  return { lat: t.latitude, lon: t.longitude, headingDeg: t.headingTrueDeg, groundSpeedMs: t.groundSpeedMs }
}

/**
 * @param icao The clearance's airport, or null when it could not be told.
 * @param clearance The clearance.
 * @param segments The airport's cached taxi network.
 * @returns Why no trace was attempted, for the log.
 */
function untracedReason(
  icao: string | null,
  clearance: TaxiClearance,
  segments: NavdataTaxiSegment[]
): string {
  if (!icao) return 'no airport for the clearance'
  if (!clearance.from) return 'no position yet'
  return segments.length === 0 ? 'no taxi network cached' : 'nothing to trace'
}

/** Traces ATC's taxi clearances and publishes the line as the `taxiRoute` topic. */
export class TaxiRouteService {
  private memory: TaxiMemory = { ...INITIAL_TAXI_MEMORY }
  private clearance: TaxiClearance | null = null
  /** The flight shown when the clearance was taken. */
  private flightId: number | null = null
  private icao: string | null = null
  private traced: TracedClearance | null = null
  private tracker: RerouteTracker | null = null
  private segments: NavdataTaxiSegment[] = []
  private position: Position | null = null
  private departed = false
  private slowLogged = false
  /** Taxi networks read from the cache, by airport; dropped when that airport is refreshed. */
  private readonly networks = new Map<string, NavdataTaxiSegment[]>()
  /** Stands, by airport, once an ask has found some. Asked for again at a later trace while there are none. */
  private readonly stands = new Map<string, NavdataStand[]>()
  private readonly standsAsked = new Set<string>()
  private revision = 0
  private lastKey = ''
  /** Which trace is the latest asked for: the answer to an earlier one, arriving late from a worker, is dropped. */
  private traceSeq = 0
  /** The trace (its traceSeq) a re-route is out for, so a second is not sent while one is; null when none is out. */
  private rerouteOut: number | null = null

  constructor(private readonly deps: TaxiRouteServiceDeps) {}

  /**
   * Starts following the hub and the navdata.
   *
   * @returns A function that stops it.
   */
  start(): () => void {
    const stops = [
      this.deps.hub.subscribe((topic, payload) => this.onTopic(topic, payload)),
      this.deps.navdata.onAirportRefreshed((icao) => this.guarded('navdata', () => this.onRefreshed(icao)))
    ]
    // What the hub already holds: the app can start mid-taxi.
    const held = this.deps.hub.snapshot()
    if (held.simTelemetry) this.position = positionOf(held.simTelemetry)
    const state = held.beyondAtcState
    if (state) this.guarded('beyondAtcState', () => this.onState(state))
    return () => stops.forEach((stop) => stop())
  }

  private onTopic<T extends LiveTopic>(topic: T, payload: LiveTopics[T]): void {
    if (topic === 'beyondAtcState') this.guarded(topic, () => this.onState(payload as BeyondAtcState))
    else if (topic === 'simTelemetry') this.guarded(topic, () => this.onTelemetry(payload as SimTelemetry))
  }

  /**
   * Runs one handler so a failure in the taxi line is logged and goes no further: the hub's other subscribers, and the next sample,
   * carry on.
   *
   * @param what What was being handled, for the log.
   * @param handler The handler.
   */
  private guarded(what: string, handler: () => void): void {
    try {
      handler()
    } catch (error) {
      logger.warn(`[taxi] ${what} not handled:`, error)
    }
  }

  private onState(state: BeyondAtcState): void {
    const result = stepTaxiBoxes(this.memory, state.infoBoxes, this.position, this.deps.now())
    this.memory = result.memory
    if (!result.clearance) return
    this.clearance = result.clearance
    this.flightId = this.deps.shownFlight()?.flightId ?? null
    this.slowLogged = false
    this.retrace()
  }

  private onTelemetry(t: SimTelemetry): void {
    this.position = positionOf(t)
    const active = this.deps.active()
    // A different flight's clearance has no business on this one.
    if (this.clearance && active && this.flightId !== null && active.flightId !== this.flightId) {
      this.clearance = null
      this.reset()
    }
    // The route held when the takeoff roll starts is the departure's: dropped then, never at an arrival.
    const departed = isDeparted(active?.phase ?? null)
    if (departed !== this.departed) {
      this.departed = departed
      if (departed) {
        this.clearance = null
        this.reset()
      }
    }
    // A clearance read before the aircraft's position was known starts from the first position that arrives.
    if (this.clearance && !this.clearance.from) {
      this.clearance = { ...this.clearance, ...startOf(this.position) }
      this.retrace()
      return
    }
    this.follow(active?.phase ?? null)
  }

  /** @param icao An airport whose navdata has just been refreshed. */
  private onRefreshed(icao: string): void {
    const before = this.networks.get(icao)
    this.networks.delete(icao)
    if (!this.clearance) return
    if (this.icao !== null && this.icao !== icao) return
    // The same network again (a refresh of the runways) changes nothing the line depends on, unless the stands it still waits for may now
    // be fetched (the sim has come up).
    const standsMissing = !!this.clearance.stand && !this.stands.has(icao)
    if (before && this.network(icao).length === before.length && !standsMissing) return
    this.retrace()
  }

  /**
   * Runs the trace for the current clearance, and starts following the line it gives.
   */
  private retrace(): void {
    // Whatever trace is out for an earlier state is not wanted now, even when this one asks for none.
    this.traceSeq += 1
    const clearance = this.clearance
    const flight = this.deps.shownFlight()
    this.traced = null
    this.tracker = null
    this.segments = []
    this.icao = null
    if (!clearance || !flight) {
      this.publish(null)
      return
    }
    const byIcao = {
      [flight.depIcao]: this.network(flight.depIcao),
      [flight.arrIcao]: this.network(flight.arrIcao)
    }
    const icao = clearanceAirport(clearance, flight.depIcao, flight.arrIcao, byIcao)
    this.icao = icao
    const segments = icao ? this.network(icao) : []
    this.segments = segments
    if (!icao || !clearance.from || segments.length === 0) {
      logger.info(`[taxi] ${icao ?? '?'} taxi route not traced: ${untracedReason(icao, clearance, segments)}`)
      this.publish(null)
      return
    }
    const { stand, threshold, holdShortRunway } = clearanceEnds(
      clearance,
      this.standsOf(icao),
      this.deps.navdata.listRunways(icao)
    )
    const job: TraceJob = { clearance, segments, stand, threshold, holdShortRunway }
    const startedAt = this.deps.now()
    const seq = ++this.traceSeq
    const finish = (traced: TracedClearance | null): void => {
      if (seq === this.traceSeq) this.finishTrace(icao, clearance, traced, holdShortRunway, startedAt)
    }
    const answer = (this.deps.trace ?? traceInline)(job)
    if (!(answer instanceof Promise)) {
      finish(answer)
      return
    }
    // Nothing is drawn while the trace is out: the line of the last clearance is not this one's.
    this.follow(this.deps.active()?.phase ?? null)
    answer
      .catch((error: unknown) => {
        // The worker could not do it: this thread does, as it always did.
        logger.warn('[taxi] the trace worker could not trace; tracing on the main thread:', error)
        return traceInline(job) as TracedClearance | null
      })
      .then(
        (traced) => this.guarded('trace', () => finish(traced)),
        (error: unknown) => logger.warn('[taxi] trace not handled:', error)
      )
  }

  /**
   * Takes a finished trace as the line and starts following it.
   *
   * @param icao The clearance's airport.
   * @param clearance The clearance.
   * @param traced The trace's answer.
   * @param holdShortRunway The runway of a hold short, for the tracker.
   * @param startedAt When the trace was asked for.
   */
  private finishTrace(
    icao: string,
    clearance: TaxiClearance,
    traced: TracedClearance | null,
    holdShortRunway: RunwayStrip | null,
    startedAt: number
  ): void {
    this.traced = traced
    this.tracker = traced ? startTracker(traced.route, holdShortRunway) : null
    this.logTrace(icao, clearance, this.deps.now() - startedAt)
    this.follow(this.deps.active()?.phase ?? null)
  }

  /**
   * @param icao The clearance's airport.
   * @param clearance The clearance.
   * @param ms How long the trace took.
   */
  private logTrace(icao: string, clearance: TaxiClearance, ms: number): void {
    const traced = this.traced
    const said = `taxiways ${clearance.taxiways.join(' ')}${clearance.holdingPoint ? `, holding point ${clearance.holdingPoint}` : ''}${clearance.stand ? `, stand ${clearance.stand}` : ''}${clearance.holdShortRunway ? `, hold short ${clearance.holdShortRunway}` : ''}`
    if (!traced) {
      logger.info(
        `[taxi] ${icao} taxi route not traced (${said}): nothing found, so nothing is drawn (${ms} ms)`
      )
      return
    }
    const why =
      traced.kind === 'pathfinder' && traced.exactProblems
        ? `: the traced line failed ${traced.exactProblems.join(', ')}`
        : traced.kind === 'pathfinder'
          ? ': no traced line'
          : ''
    const flaws = traced.problems.length > 0 ? `, with problems ${traced.problems.join(', ')}` : ''
    logger.info(
      `[taxi] ${icao} taxi route traced (${traced.kind})${why}${flaws} (${said}): ${traced.route.length} points in ${ms} ms`
    )
  }

  /**
   * Moves the line with the aircraft, re-routing it first if it has left the line, and publishes what is left of it.
   *
   * @param phase The tracked flight's phase, or null with none.
   */
  private follow(phase: FlightPhase | null): void {
    const { tracker, position } = this
    if (!this.clearance) return
    if (!tracker || !position) {
      this.publish(null)
      return
    }
    const startedAt = this.deps.now()
    const step = followPosition(tracker, {
      position,
      phase,
      nowMs: this.deps.now(),
      segments: this.segments
    })
    const ms = this.deps.now() - startedAt
    if (ms > SLOW_TRACK_MS && !this.slowLogged) {
      this.slowLogged = true
      logger.warn(
        `[taxi] following the taxi line took ${ms} ms (over ${SLOW_TRACK_MS}); logged once per clearance`
      )
    }
    this.tracker = step.tracker
    if (step.reroute && this.rerouteOut !== this.traceSeq && this.reroute(step.reroute)) return
    this.publish(step.line)
  }

  /**
   * Has the line re-routed: on the worker in the app, so the old line keeps following until the answer comes back.
   *
   * @param request Where the aircraft was and the route to rejoin.
   * @returns Whether the re-routed line was taken (and published) at once, as it is when the search runs inline.
   */
  private reroute(request: RejoinRequest): boolean {
    const seq = this.traceSeq
    const startedAt = this.deps.now()
    const answer = (this.deps.rejoin ?? rejoinInline)(request)
    if (!(answer instanceof Promise)) return this.finishReroute(answer, startedAt)
    this.rerouteOut = seq
    answer
      .catch((error: unknown) => {
        // The worker could not do it: this thread does, as it always did.
        logger.warn('[taxi] the trace worker could not re-route; re-routing on the main thread:', error)
        return rejoinInline(request) as TracedRoute | null
      })
      .then(
        (next) =>
          this.guarded('re-route', () => {
            if (this.rerouteOut === seq) this.rerouteOut = null
            // A re-route for an earlier clearance, or one dropped since (takeoff, another flight), is not wanted now.
            if (seq === this.traceSeq) this.finishReroute(next, startedAt)
          }),
        (error: unknown) => logger.warn('[taxi] re-route not handled:', error)
      )
    return false
  }

  /**
   * Takes a re-routed line, from where the aircraft is now, and publishes it.
   *
   * @param next The re-routed line, or null when none was found (the old line stays).
   * @param startedAt When the re-route was asked for.
   * @returns Whether it was taken.
   */
  private finishReroute(next: TracedRoute | null, startedAt: number): boolean {
    const { tracker, position } = this
    // Reached the end while the answer was out: the clearance is done, and nothing re-routes.
    if (!next || !tracker || !position || tracker.done) return false
    const applied = applyReroute(tracker, next, position)
    this.tracker = applied.tracker
    logger.info(
      `[taxi] ${this.icao} taxi line re-routed at ${position.lat.toFixed(5)}, ${position.lon.toFixed(5)}: ${next.length} points (${this.deps.now() - startedAt} ms)`
    )
    this.publish(applied.line)
    return true
  }

  /** @returns Nothing is shown any more: no clearance, and nothing traced. */
  private reset(): void {
    this.traceSeq += 1
    this.traced = null
    this.tracker = null
    this.segments = []
    this.icao = null
    this.publish(null)
  }

  /**
   * @param icao An airport.
   * @returns Its taxi network from the cache (not kept when it is empty, so a network fetched later is found).
   */
  private network(icao: string): NavdataTaxiSegment[] {
    const known = this.networks.get(icao)
    if (known) return known
    const fetched = this.deps.navdata.getTaxiNetwork(icao)
    if (fetched.length > 0) this.networks.set(icao, fetched)
    return fetched
  }

  /**
   * The airport's stands for a stand clearance. They may have to be fetched from the sim, so the first ask answers with none and the line
   * is traced again when they arrive; an ask that finds none is made again at the next trace (the stands may only fail to load while the
   * sim is down).
   *
   * @param icao The airport.
   * @returns The stands known so far.
   */
  private standsOf(icao: string): NavdataStand[] {
    const known = this.stands.get(icao)
    if (known) return known
    if (!this.standsAsked.has(icao)) {
      this.standsAsked.add(icao)
      this.deps.navdata.getStands(icao).then(
        (list) => {
          this.standsAsked.delete(icao)
          if (list.length === 0) return
          this.stands.set(icao, list)
          if (this.clearance?.stand && this.icao === icao) this.guarded('stands', () => this.retrace())
        },
        () => this.standsAsked.delete(icao)
      )
    }
    return []
  }

  /**
   * Publishes the line and clearance when they differ from what was last published.
   *
   * @param line What is left of the line, or null when there is nothing to draw and so nothing is shown.
   */
  private publish(line: [number, number][] | null): void {
    const clearance = this.clearance
    const shown = clearance && !this.departed
    const payload: Omit<TaxiRoute, 'revision'> | null = shown
      ? {
          flightId: this.flightId,
          icao: this.icao ?? '',
          kind: this.traced && line ? this.traced.kind : null,
          line: this.traced && line ? line : [],
          clearance: {
            taxiways: clearance.taxiways,
            holdingPoint: clearance.holdingPoint,
            stand: clearance.stand,
            holdShortRunway: clearance.holdShortRunway
          }
        }
      : null
    const key = JSON.stringify(payload)
    if (key === this.lastKey) return
    this.lastKey = key
    this.revision += 1
    this.deps.hub.publish('taxiRoute', payload && { ...payload, revision: this.revision })
  }
}
