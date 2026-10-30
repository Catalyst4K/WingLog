/**
 * The prefile channels (winglog-backend docs/plans/vatsim-build.md, Step 3): open the chosen network's own filing page, from the link
 * SimBrief put in the OFP. Channel kind (coding-standards.md §9): **local**, since they open a page outside the app.
 *
 * WingLog files nothing and holds no network credentials: the link is opened in the browser, where the pilot logs in and presses File.
 */
import type { IpcMain } from 'electron'
import { IpcChannels } from '@shared/ipc'
import type { WingLogDb } from '../db/client'
import { getFlight } from '../db/flight-repo'
import { asOnlineNetwork, extractPrefileUrl } from './prefile-url'

/** What the prefile channels need. */
export interface PrefileHandlerDeps {
  db: WingLogDb
  /** Opens an address in the user's browser (Electron's `shell.openExternal`). */
  openExternal: (url: string) => Promise<void>
}

/**
 * @param ipcMain Electron's IPC.
 * @param deps The database and the browser opener.
 */
export function registerPrefileHandlers(ipcMain: IpcMain, { db, openExternal }: PrefileHandlerDeps): void {
  const open = async (ofpJson: string | null, network: unknown): Promise<boolean> => {
    const chosen = asOnlineNetwork(network)
    const url = chosen ? extractPrefileUrl(ofpJson, chosen) : null
    if (!url) return false
    await openExternal(url)
    return true
  }
  // Dispatch holds the OFP before a flight exists, so it passes the JSON it has. The link is checked here either way.
  ipcMain.handle(IpcChannels.onlinePrefileFromOfp, (_event, ofpJson: unknown, network: unknown) =>
    open(typeof ofpJson === 'string' ? ofpJson : null, network)
  )
  ipcMain.handle(IpcChannels.onlinePrefileForFlight, (_event, flightId: unknown, network: unknown) =>
    open(typeof flightId === 'number' ? (getFlight(db, flightId)?.ofpJson ?? null) : null, network)
  )
}
