/** Starts the procedure selection store and answers the PC window's asks of it, and of the planned route built from it. */

import type { IpcMain } from 'electron'
import { IpcChannels } from '@shared/ipc'
import type { WingLogDb } from '../db/client'
import { setSelectedProcedures } from '../db/flight-repo'
import { shownFlight } from '../lan/lan-flight'
import type { LiveHub } from '../live/LiveHub'
import { parseProcedureSelection } from '../live/commands'
import type { TrackingController } from '../tracking/TrackingController'
import { ProcedureSelectionStore, type ProcedureSelectionStoreDeps } from './ProcedureSelectionStore'

/**
 * @param ipcMain Electron's IPC.
 * @param deps The database, the live hub, tracking and the navdata cache, and what to call after each save (`scheduleBackgroundSync`: the
 *   choice is a change to the flight's row, which a twin and the cloud must hear of like any other).
 * @returns The store, already looking at the flight shown.
 */
export function startProcedureSelection(
  ipcMain: IpcMain,
  {
    db,
    onWrite,
    hostFlying,
    liveHub,
    trackingController,
    navdata
  }: {
    db: WingLogDb
    onWrite: () => void
    /** On a client: whether the sim PC is flying a flight. The sim PC owns that flight's choice, so none is held, suggested or saved here. */
    hostFlying?: () => boolean
    liveHub: Pick<LiveHub, 'publish' | 'snapshot'>
    trackingController: Pick<TrackingController, 'getActive' | 'on'>
    navdata: ProcedureSelectionStoreDeps['navdata']
  }
): ProcedureSelectionStore {
  const store = new ProcedureSelectionStore({
    shownFlight: () =>
      hostFlying?.() ? undefined : shownFlight(db, trackingController.getActive()?.flightId),
    save: (flightId, selection) => {
      setSelectedProcedures(db, flightId, selection)
      onWrite()
    },
    navdata
  })
  store.on('changed', (selection) => {
    // Not the empty announcement while the sim PC owns the choice: it would replace what the sim PC last said in this computer's hub.
    if (selection === null && hostFlying?.()) return
    liveHub.publish('procedureSelection', selection)
  })
  for (const event of ['started', 'stopped', 'completed'] as const)
    trackingController.on(event, () => store.refresh())
  // A window checks every field, like a phone does: the renderer is not a security boundary.
  ipcMain.handle(IpcChannels.trackingSetProcedureSelection, (_event, selection: unknown) =>
    store.set(parseProcedureSelection(selection), 'window')
  )
  // A window that opens later (or after a restart) asks for the choice it should show: it is only pushed when it changes.
  ipcMain.handle(IpcChannels.trackingGetProcedureSelection, () => store.current() ?? null)
  // Likewise the route built from it (PlannedRoutePublisher): it is only pushed when it changes.
  ipcMain.handle(IpcChannels.plannedRouteGet, () => liveHub.snapshot().plannedRoute ?? null)
  store.refresh()
  return store
}
