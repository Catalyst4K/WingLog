/**
 * The flight the sim PC is tracking, as a client sees it (winglog-backend's docs/plans/multi-device.md, Part 3). The host's flight has its
 * own database ids, which mean nothing here, so it is known by its uuid: once LAN sync has put the flight in this computer's database, its
 * local id stands for it. Until then nothing about it is shown, rather than something bound to the wrong flight.
 */

import type { ActiveTracking, FlightPhase, LanFlightSnapshot, TrackPoint } from '@shared/ipc'
import type { PlannedRoute } from '@shared/live'

/**
 * What a topic's mapper returns for a value that cannot be shown yet (its flight has not synced here). Not null: null is a real value
 * several topics carry (a finished GSX routine, a cleared taxi route), and holding it back left the twin showing the last real one.
 */
export const HELD_BACK: unique symbol = Symbol('held back')

/** The flight mirrored from the sim PC. */
export class FlightMirror {
  private snapshot: LanFlightSnapshot | null = null
  private phase: FlightPhase | null = null
  private points: () => TrackPoint[] = () => []
  /** The sim PC's route that could not be re-labelled yet because its flight has not synced here; tried again after each sync. */
  private heldRoute: PlannedRoute | null = null

  /** @param localFlightId The id of the flight with this uuid in this computer's database, or undefined when it has not synced yet. */
  constructor(private readonly localFlightId: (uuid: string) => number | undefined) {}

  /**
   * @param snapshot The flight the sim PC shows now (null when none).
   * @param points The track it has recorded so far, kept up to date by the link.
   */
  setFlight(snapshot: LanFlightSnapshot | null, points: () => TrackPoint[]): void {
    this.snapshot = snapshot
    this.points = points
    if (!snapshot?.flight.tracking) this.phase = null
  }

  /** Forgets the flight (the link was closed or forgotten). */
  clear(): void {
    this.snapshot = null
    this.phase = null
    this.points = () => []
    this.heldRoute = null
  }

  /**
   * @param hostFlightId A flight id as the sim PC knows it.
   * @returns The id of the same flight in this computer's database, or null when it is not the flight shown or has not synced yet.
   */
  localIdOf(hostFlightId: number): number | null {
    const flight = this.snapshot?.flight
    if (!flight || flight.flightId !== hostFlightId || !flight.uuid) return null
    return this.localFlightId(flight.uuid) ?? null
  }

  /**
   * Re-labels a point the sim PC sent with this computer's id for its flight, and remembers the phase.
   *
   * @param point A point as the sim PC sent it.
   * @returns The point for this computer, or null when its flight is not known here yet.
   */
  mapPoint(point: TrackPoint): TrackPoint | null {
    const flightId = this.localIdOf(point.flightId)
    if (flightId === null) return null
    this.phase = point.phase
    return { ...point, flightId }
  }

  /**
   * Re-labels the planned route the sim PC sent with this computer's id for its flight, found by the uuid the route carries (the flight
   * it shows may be one that is planned and not tracked, so the tracked flight's snapshot is no help). A route that cannot be placed yet
   * is remembered, so `releaseHeldRoute` can place it once the flight's row has synced.
   *
   * @param route A route as the sim PC sent it.
   * @returns The route for this computer, or null when its flight has not synced here (or the sim PC did not say which flight it is).
   */
  mapRoute(route: PlannedRoute): PlannedRoute | null {
    const flightId = route.flightUuid ? this.localFlightId(route.flightUuid) : undefined
    this.heldRoute = flightId === undefined ? route : null
    return flightId === undefined ? null : { ...route, flightId }
  }

  /** @returns The route held back earlier, re-labelled, now that its flight may have synced; null when none is held or it still cannot be placed. */
  releaseHeldRoute(): PlannedRoute | null {
    const held = this.heldRoute
    return held ? this.mapRoute(held) : null
  }

  /** Forgets a route held back: the sim PC has cleared its route since. */
  clearHeldRoute(): void {
    this.heldRoute = null
  }

  /** @returns True while the sim PC is tracking a flight, whether or not that flight has synced to this computer yet. */
  hostTracking(): boolean {
    return Boolean(this.snapshot?.flight.tracking)
  }

  /** @returns The flight being tracked on the sim PC as this computer's own Track screen reads it, or null when none is or it has not synced yet. */
  active(): ActiveTracking | null {
    const flight = this.snapshot?.flight
    if (!flight?.tracking) return null
    const flightId = this.localIdOf(flight.flightId)
    return flightId === null ? null : { flightId, phase: this.phase ?? 'preflight' }
  }

  /**
   * @param flightId A flight id on this computer.
   * @returns The points the sim PC has recorded of that flight so far, when it is the flight being tracked there; otherwise null (read the database).
   */
  livePoints(flightId: number): TrackPoint[] | null {
    const flight = this.snapshot?.flight
    if (!flight?.tracking || this.localIdOf(flight.flightId) !== flightId) return null
    // The id was found once, above: finding it again for every point scanned the flight table once per point (a few thousand times).
    const points = this.points()
      .filter((point) => point.flightId === flight.flightId)
      .map((point) => ({ ...point, flightId }))
    const last = points.at(-1)
    if (last) this.phase = last.phase
    return points
  }
}

/**
 * @param mirror The flight the sim PC is tracking, as this computer knows it.
 * @param topic A topic the sim PC published.
 * @param payload Its value.
 * @returns The value for this computer: a point or a planned route with this computer's flight id, or HELD_BACK while that flight has not synced here yet. Other topics as they are, null included.
 */
export function mapFlightTopic(mirror: FlightMirror, topic: string, payload: unknown): unknown {
  if (topic === 'trackingPoint') return mirror.mapPoint(payload as TrackPoint) ?? HELD_BACK
  if (topic === 'trackingPointsUpdated') {
    const points = (payload as TrackPoint[]).flatMap((point) => mirror.mapPoint(point) ?? [])
    return points.length > 0 ? points : HELD_BACK
  }
  // A null is the sim PC clearing the route: it is a value, and drops any route held back.
  if (topic === 'plannedRoute' && payload !== null)
    return mirror.mapRoute(payload as PlannedRoute) ?? HELD_BACK
  if (topic === 'plannedRoute') mirror.clearHeldRoute()
  return payload
}
