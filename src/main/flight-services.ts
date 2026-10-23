/**
 * The services that follow the flight shown (the planned or tracked one), started together: its navdata fetched from the sim, the taxi line
 * traced for its clearances, and the procedure choice held for it. Each runs in the main process whichever screen is open
 * (winglog-backend's docs/plans/taxi-and-second-screen-robustness.md).
 */

import type { IpcMain } from 'electron'
import type { WingLogDb } from './db/client'
import type { LiveHub } from './live/LiveHub'
import type { SimStatusSource } from './ipc/sim-handlers'
import type { SimFacilitiesProvider } from './navdata/sim-facilities-provider'
import { wireFlightNavdata } from './navdata/wire-flight-navdata'
import { startTaxiRoute } from './taxi/start-taxi-route'
import type { WorkerTraceRunner } from './taxi/worker-trace-runner'
import type { ProcedureSelectionStore } from './procedures/ProcedureSelectionStore'
import { startProcedureSelection } from './procedures/start-procedure-selection'
import type { TrackingController } from './tracking/TrackingController'

/** What the rest of the app needs from them. */
export interface FlightServices {
  /** The procedure choice for the flight shown. */
  selection: ProcedureSelectionStore
  /** Called after a flight is planned, cancelled, deleted or linked to an aircraft: the flight shown may have changed. */
  onFlightsChanged: () => void
  /** Stops what can be stopped (at quit). */
  stop: () => void
}

/**
 * @param ipcMain Electron's IPC.
 * @param deps The database, the sim, the live hub, tracking and the navdata cache.
 * @returns The services.
 */
export function startFlightServices(
  ipcMain: IpcMain,
  {
    db,
    sim,
    liveHub,
    trackingController,
    navdata,
    traceWorker
  }: {
    db: WingLogDb
    sim: SimStatusSource
    liveHub: LiveHub
    trackingController: TrackingController
    navdata: SimFacilitiesProvider
    /** Runs the taxi line's traces on a worker thread; they run on this one when absent. */
    traceWorker?: WorkerTraceRunner
  }
): FlightServices {
  const flightNavdata = wireFlightNavdata({ db, sim, trackingController, provider: navdata })
  const stopTaxiRoute = startTaxiRoute(ipcMain, {
    db,
    liveHub,
    trackingController,
    navdata,
    trace: traceWorker && ((job) => traceWorker.run(job))
  })
  const selection = startProcedureSelection(ipcMain, { db, liveHub, trackingController, navdata })
  return {
    selection,
    onFlightsChanged: () => {
      flightNavdata.refresh()
      selection.refresh()
    },
    stop: () => {
      stopTaxiRoute()
      traceWorker?.stop()
    }
  }
}
