/** Starts the taxi line service and answers a window's ask for the line it holds. */

import type { IpcMain } from 'electron'
import { IpcChannels } from '@shared/ipc'
import type { WingLogDb } from '../db/client'
import type { LiveHub } from '../live/LiveHub'
import { shownFlightOf } from '../navdata/wire-flight-navdata'
import type { TrackingController } from '../tracking/TrackingController'
import { TaxiRouteService, type TaxiRouteServiceDeps } from './TaxiRouteService'

/**
 * @param ipcMain Electron's IPC.
 * @param deps The database, the live hub, tracking and the navdata cache.
 * @returns A function that stops the service.
 */
export function startTaxiRoute(
  ipcMain: IpcMain,
  {
    db,
    liveHub,
    trackingController,
    navdata,
    trace
  }: {
    db: WingLogDb
    liveHub: LiveHub
    trackingController: Pick<TrackingController, 'getActive'>
    navdata: TaxiRouteServiceDeps['navdata']
    /** Traces a clearance somewhere else than this thread (the app's worker); inline when absent. */
    trace?: TaxiRouteServiceDeps['trace']
  }
): () => void {
  // A window that opens mid-taxi asks for the line now: a parked aircraft's line doesn't change, so nothing would be pushed.
  ipcMain.handle(IpcChannels.taxiRouteGet, () => liveHub.snapshot().taxiRoute ?? null)
  return new TaxiRouteService({
    hub: liveHub,
    navdata,
    shownFlight: () => shownFlightOf(db, trackingController.getActive()?.flightId),
    active: () => trackingController.getActive(),
    now: () => Date.now(),
    trace
  }).start()
}
