/**
 * What a client runs instead of the host's services (winglog-backend's docs/plans/multi-device.md, Parts 2 and 4): the link to the sim PC's
 * WingLog, which republishes its live topics into this computer's hub and forwards the commands a phone may send, and the sync that keeps
 * this computer's fleet and logbook in step with the sim PC's.
 */
import { hostname } from 'node:os'
import { app, ipcMain, type BrowserWindow } from 'electron'
import { IpcChannels } from '@shared/ipc'
import type { WingLogDb } from './db/client'
import { runLogged } from './logging/run-logged'
import type { LiveHub } from './live/LiveHub'
import { HostLink } from './host-link/HostLink'
import { registerHostLinkHandlers } from './host-link/client-ipc'
import { fileHostLinkStore } from './host-link/host-link-store'
import { LanSyncClient } from './host-link/lan-sync-client'
import { SYNC_AFTER_WRITE_MS, TwinSync } from './host-link/TwinSync'
import { openHostSocket } from './host-link/ws-socket'
import { onLocalWrite } from './sync/local-write-hints'

/**
 * Starts the link to the sim PC, if this computer was paired with one, and answers the renderer's calls about it.
 *
 * @param deps The hub to republish into, the window to tell of changes, the channels already answered, and the database.
 * @param deps.liveHub This computer's hub.
 * @param deps.window The main window.
 * @param deps.handled The channels already answered, which the link takes over.
 * @param deps.db The database that is kept in step with the sim PC's.
 * @param deps.dbPath The database file's path, where conflicts are logged next to it.
 */
export function startClientServices(deps: {
  liveHub: LiveHub
  window: BrowserWindow
  handled: ReadonlySet<string>
  db: WingLogDb
  dbPath: string
}): void {
  const { liveHub, window, handled, db, dbPath } = deps
  const sync = new TwinSync({
    db,
    dbPath,
    client: new LanSyncClient((name, ...args) => link.query(name, ...args)),
    canSync: () => link.getStatus().state === 'connected'
  })
  const link: HostLink = new HostLink({
    hub: liveHub,
    store: fileHostLinkStore(app.getPath('userData')),
    createSocket: openHostSocket,
    deviceName: `WingLog on ${hostname()}`,
    onStatus: (status) => {
      if (!window.isDestroyed()) window.webContents.send(IpcChannels.hostLinkStatus, status)
    },
    sync
  })
  registerHostLinkHandlers(ipcMain, { link, hub: liveHub, handled })
  // A change made here reaches the sim PC soon after.
  onLocalWrite(() => sync.syncSoon(SYNC_AFTER_WRITE_MS))
  runLogged('host link at launch', link.start())
  app.on('before-quit', () => {
    sync.stop()
    link.stop()
  })
}
