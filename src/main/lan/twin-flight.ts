/**
 * The host's side of a twin's flight commands (winglog-backend's docs/plans/multi-device.md, Part 3): plan a flight on the other
 * computer, then fly, start, finish or cancel it here, where the sim is. They are lookups, not commands, so the twin gets an answer
 * (or a refusal it can show), and they are twin-only: a phone cannot ask them. A flight is named by its uuid, which is the same on both
 * computers once LAN sync has carried it across.
 */

import type { WingLogDb } from '../db/client'
import type { SimTelemetry } from '@shared/ipc'
import {
  abandonFlight,
  getFlightIdByUuid,
  getFlightUuidById,
  getLiveFlight,
  listFlightSummaries
} from '../db/flight-repo'
import type { AutoStartDetector } from '../tracking/AutoStartDetector'
import type { TrackingController } from '../tracking/TrackingController'

/** What a twin may make the sim PC do with a flight. Each throws when it must refuse. */
export interface FlightControl {
  /** Replaces what was in progress with this planned flight and waits for the pilot to start (auto-start armed), as Fly does here. */
  fly(uuid: string): void
  /** Starts tracking a planned flight now. */
  start(uuid: string): void
  /** Finishes and saves the flight being tracked. */
  finish(): void
  /** Stops tracking the flight in progress without saving it. */
  stop(): void
  /** Cancels a planned flight: it is abandoned and auto-start is disarmed. Refuses a flight that is not planned, as fly and start do. */
  cancel(uuid: string): void
  /** Sets the destination of the free flight being tracked, when it is the flight with this uuid. A blank or null code means not set. */
  setDestination(uuid: string, icao: string | null): void
  /** Sets the departure of the free flight being tracked, when it is the flight with this uuid. A blank or null code means not set. */
  setDeparture(uuid: string, icao: string | null): void
}

/** Longest uuid taken from a twin. */
const MAX_UUID_CHARS = 64

/** Longest airport code taken from a twin, before the tracking controller checks it (an ICAO code is 4 characters; the controller takes 2 to 5). */
const MAX_ICAO_CHARS = 8

/**
 * @param value A flight's uuid from a twin.
 * @returns The uuid.
 * @throws When it is not a short text.
 */
function uuidArg(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_UUID_CHARS) {
    throw new Error('Invalid flight')
  }
  return value
}

/**
 * @param value An airport code from a twin.
 * @returns The code as sent, or null for none.
 * @throws When it is neither null nor a short text.
 */
function icaoArg(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length > MAX_ICAO_CHARS) throw new Error('Invalid airport')
  return value
}

/**
 * The control over this computer's tracking.
 *
 * @param deps The database, tracking, auto-start, where the aircraft is now (for arming), the replay hold and the flight a second screen shows.
 * @param deps.db The database.
 * @param deps.trackingController Tracking.
 * @param deps.autoStartDetector Auto-start.
 * @param deps.getLastTelemetry Where the aircraft is now.
 * @param deps.releaseReplay Lets an e2e replay held until tracking starts play.
 * @param deps.onFlightsChanged Called after a flight is planned or cancelled: what a second screen shows may have changed.
 * @param deps.scheduleBackgroundSync Called after a flight is abandoned, so a twin and the cloud are told.
 * @returns The control.
 */
export function flightControl(deps: {
  db: WingLogDb
  trackingController: Pick<
    TrackingController,
    'start' | 'stop' | 'finish' | 'getActive' | 'setDestination' | 'setDeparture'
  >
  autoStartDetector: Pick<AutoStartDetector, 'arm' | 'disarm'>
  getLastTelemetry: () => SimTelemetry | undefined
  releaseReplay: () => void
  onFlightsChanged?: () => void
  /** Called after a flight row is written here, so the twins and the cloud hear of it (`scheduleBackgroundSync`). */
  scheduleBackgroundSync?: () => void
}): FlightControl {
  const { db, trackingController, autoStartDetector } = deps
  /**
   * @param uuid A flight's uuid.
   * @returns The planned flight with it.
   * @throws When it has not reached this computer, or is not planned.
   */
  function plannedFlight(uuid: string): { id: number; depIcao: string } {
    const id = getFlightIdByUuid(db, uuid)
    const flight = id === undefined ? undefined : getLiveFlight(db, id)
    if (!flight) throw new Error('Unknown flight: it has not reached this computer yet')
    if (flight.status !== 'planned') throw new Error('The flight is not planned')
    return { id: flight.id, depIcao: flight.depIcao }
  }
  /**
   * @param uuid A flight's uuid.
   * @throws When it is not the flight being tracked: the airports are the tracked flight's, and a twin a moment behind must not set another's.
   */
  function requireTracked(uuid: string): void {
    const flightId = trackingController.getActive()?.flightId
    if (flightId === undefined || getFlightUuidById(db, flightId) !== uuid) {
      throw new Error('The flight is not the one being tracked')
    }
  }
  return {
    fly(uuid) {
      const flight = plannedFlight(uuid)
      trackingController.stop()
      // Only one flight is in progress at once: this one replaces whatever else was planned.
      for (const other of listFlightSummaries(db)) {
        if (other.status === 'planned' && other.id !== flight.id) abandonFlight(db, other.id)
      }
      deps.scheduleBackgroundSync?.()
      autoStartDetector.arm(flight.id, deps.getLastTelemetry(), flight.depIcao)
      deps.onFlightsChanged?.()
    },
    start(uuid) {
      const flight = plannedFlight(uuid)
      autoStartDetector.disarm()
      trackingController.start(flight.id)
      deps.releaseReplay()
    },
    finish: () => trackingController.finish(),
    stop: () => trackingController.stop(),
    setDestination(uuid, icao) {
      requireTracked(uuid)
      trackingController.setDestination(icao)
    },
    setDeparture(uuid, icao) {
      requireTracked(uuid)
      trackingController.setDeparture(icao)
    },
    cancel(uuid) {
      // Only a planned flight: abandoning deletes a flight's track points for good and the deletion syncs to every computer (audit M9).
      abandonFlight(db, plannedFlight(uuid).id)
      deps.scheduleBackgroundSync?.()
      autoStartDetector.disarm()
      deps.onFlightsChanged?.()
    }
  }
}

/**
 * @param control What a twin may make this computer do with a flight.
 * @param onChanged Called after a command ran, so the window on this computer reads the flights again (it did not make the change).
 * @returns The lookups a twin may ask: \`flight.fly\`, \`flight.start\`, \`flight.finish\`, \`flight.stop\`, \`flight.cancel\`, and \`flight.setDestination\` and \`flight.setDeparture\` (flight data, not settings).
 */
export function twinFlightQueries(
  control: FlightControl,
  onChanged: () => void = () => {}
): Record<string, (...args: unknown[]) => unknown> {
  const then = (run: () => void): void => {
    run()
    onChanged()
  }
  return {
    'flight.fly': (uuid) => then(() => control.fly(uuidArg(uuid))),
    'flight.start': (uuid) => then(() => control.start(uuidArg(uuid))),
    'flight.finish': () => then(() => control.finish()),
    'flight.stop': () => then(() => control.stop()),
    'flight.cancel': (uuid) => then(() => control.cancel(uuidArg(uuid))),
    'flight.setDestination': (uuid, icao) => then(() => control.setDestination(uuidArg(uuid), icaoArg(icao))),
    'flight.setDeparture': (uuid, icao) => then(() => control.setDeparture(uuidArg(uuid), icaoArg(icao)))
  }
}
