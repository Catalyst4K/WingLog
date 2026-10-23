/** Connects the flight navdata fetcher to the app: when the shown flight may have changed, and when the sim connects. */

import type { WingLogDb } from '../db/client'
import { getLiveFlight } from '../db/flight-repo'
import { shownFlightId } from '../lan/lan-flight'
import type { SimStatusSource } from '../ipc/sim-handlers'
import type { TrackingController } from '../tracking/TrackingController'
import {
  FlightNavdataFetcher,
  type FlightNavdataFetcherDeps,
  type ShownFlight
} from './flight-navdata-fetcher'

/**
 * @param db The database.
 * @param activeFlightId The flight being tracked, if any.
 * @returns The flight a second screen would show: the tracked one, else the newest planned one.
 */
export function shownFlightOf(db: WingLogDb, activeFlightId: number | undefined): ShownFlight | undefined {
  const id = shownFlightId(db, activeFlightId)
  const flight = id === undefined ? undefined : getLiveFlight(db, id)
  return flight
    ? { flightId: flight.id, depIcao: flight.depIcao, arrIcao: flight.arrIcao, ofpJson: flight.ofpJson }
    : undefined
}

/**
 * Creates the fetcher and has it look again whenever the tracking changes state or the sim connects, and once now (a flight planned
 * before the app was last closed is still shown).
 *
 * @param deps The database, the sim, tracking and the sim's facility data.
 * @returns The fetcher, whose `refresh` the flight handlers call when a flight is planned, cancelled or deleted.
 */
export function wireFlightNavdata({
  db,
  sim,
  trackingController,
  provider
}: {
  db: WingLogDb
  sim: SimStatusSource
  trackingController: Pick<TrackingController, 'on' | 'getActive'>
  provider: FlightNavdataFetcherDeps['provider']
}): FlightNavdataFetcher {
  const fetcher = new FlightNavdataFetcher({
    provider,
    shownFlight: () => shownFlightOf(db, trackingController.getActive()?.flightId),
    simConnected: () => sim.getStatus().state === 'connected',
    now: () => Date.now()
  })
  for (const event of ['started', 'stopped', 'completed'] as const)
    trackingController.on(event, () => fetcher.refresh())
  sim.on('status', (status) => {
    if (status.state === 'connected') fetcher.refresh()
  })
  fetcher.refresh()
  return fetcher
}
