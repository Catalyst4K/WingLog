/**
 * The channels a client answers from its own computer rather than through the sim PC: the GSX routines (rows in its own database, kept level
 * by sync) and filing on VATSIM or IVAO (the network's own page, opened in this computer's browser from the link in this computer's copy of
 * the flight's OFP; WingLog sends nothing). Which network to file on is the sim PC's setting, read in `client-ipc.ts`.
 */
import type { IpcMain } from 'electron'
import type { WingLogDb } from '../db/client'
import { registerRoutineQueries } from '../ipc/gsx-remote-handlers'
import { registerPrefileHandlers } from '../online/register-prefile-handlers'

/**
 * @param ipcMain Electron's IPC.
 * @param deps This computer's database and its browser opener (Electron's `shell.openExternal`).
 * @param deps.db The database.
 * @param deps.openExternal Opens an address in this computer's browser.
 */
export function registerClientLocalHandlers(
  ipcMain: IpcMain,
  deps: { db: WingLogDb; openExternal: (url: string) => Promise<void> }
): void {
  registerPrefileHandlers(ipcMain, deps)
  registerRoutineQueries(ipcMain, deps.db)
}
