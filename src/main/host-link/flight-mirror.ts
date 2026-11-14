/**
 * The flight the sim PC is tracking, as a client sees it (winglog-backend's docs/plans/multi-device.md, Part 3). The host's flight has its
 * own database ids, which mean nothing here, so it is known by its uuid: once LAN sync has put the flight in this computer's database, its
 * local id stands for it. Until then nothing about it is shown, rather than something bound to the wrong flight.
 */

import type { ActiveTracking, FlightPhase, LanFlightSnapshot, TrackPoint } from '@shared/ipc'

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
    return this.points().flatMap((point) => {
      const mapped = this.mapPoint(point)
      return mapped ? [mapped] : []
    })
  }
}

/**
 * @param mirror The flight the sim PC is tracking, as this computer knows it.
 * @param topic A topic the sim PC published.
 * @param payload Its value.
 * @returns The value for this computer: a point with this computer's flight id, or HELD_BACK while that flight has not synced here yet. Other topics as they are, null included.
 */
export function mapFlightTopic(mirror: FlightMirror, topic: string, payload: unknown): unknown {
  if (topic === 'trackingPoint') return mirror.mapPoint(payload as TrackPoint) ?? HELD_BACK
  if (topic === 'trackingPointsUpdated') {
    const points = (payload as TrackPoint[]).flatMap((point) => mirror.mapPoint(point) ?? [])
    return points.length > 0 ? points : HELD_BACK
  }
  return payload
}
