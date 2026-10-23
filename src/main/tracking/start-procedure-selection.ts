/** Starts the procedure selection store and answers the PC window's asks of it. */

import type { IpcMain } from 'electron'
import { IpcChannels } from '@shared/ipc'
import type { WingLogDb } from '../db/client'
import { setSelectedProcedures } from '../db/flight-repo'
import { shownFlight } from '../lan/lan-flight'
import type { LiveHub } from '../live/LiveHub'
import { parseProcedureSelection } from '../live/commands'
import { ProcedureSelectionStore, type ProcedureSelectionStoreDeps } from './ProcedureSelectionStore'
import type { TrackingController } from './TrackingController'

/**
 * @param ipcMain Electron's IPC.
 * @param deps The database, the live hub, tracking and the navdata cache.
 * @returns The store, already looking at the flight shown.
 */
export function startProcedureSelection(
  ipcMain: IpcMain,
  {
    db,
    liveHub,
    trackingController,
    navdata
  }: {
    db: WingLogDb
    liveHub: Pick<LiveHub, 'publish'>
    trackingController: Pick<TrackingController, 'getActive' | 'on'>
    navdata: ProcedureSelectionStoreDeps['navdata']
  }
): ProcedureSelectionStore {
  const store = new ProcedureSelectionStore({
    shownFlight: () => shownFlight(db, trackingController.getActive()?.flightId),
    save: (flightId, selection) => setSelectedProcedures(db, flightId, selection),
    navdata
  })
  store.on('changed', (selection) => liveHub.publish('procedureSelection', selection))
  for (const event of ['started', 'stopped', 'completed'] as const)
    trackingController.on(event, () => store.refresh())
  // A window checks every field, like a phone does: the renderer is not a security boundary.
  ipcMain.handle(IpcChannels.trackingSetProcedureSelection, (_event, selection: unknown) =>
    store.set(parseProcedureSelection(selection), 'window')
  )
  // A window that opens later (or after a restart) asks for the choice it should show: it is only pushed when it changes.
  ipcMain.handle(IpcChannels.trackingGetProcedureSelection, () => store.current() ?? null)
  store.refresh()
  return store
}
