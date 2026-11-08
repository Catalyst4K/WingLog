/**
 * What a client runs instead of the host's services (winglog-backend's docs/plans/multi-device.md, Part 2): the link to the sim PC's
 * WingLog, which republishes its live topics into this computer's hub and forwards the commands a phone may send.
 */
import { hostname } from 'node:os'
import { app, ipcMain, type BrowserWindow } from 'electron'
import { IpcChannels } from '@shared/ipc'
import { runLogged } from './logging/run-logged'
import type { LiveHub } from './live/LiveHub'
import { HostLink } from './host-link/HostLink'
import { registerHostLinkHandlers } from './host-link/client-ipc'
import { fileHostLinkStore } from './host-link/host-link-store'
import { openHostSocket } from './host-link/ws-socket'

/**
 * Starts the link to the sim PC, if this computer was paired with one, and answers the renderer's calls about it.
 *
 * @param deps The hub to republish into and the window to tell of changes.
 * @param deps.liveHub This computer's hub.
 * @param deps.window The main window.
 * @param deps.handled The channels already answered, which the link leaves alone.
 */
export function startClientServices(deps: {
  liveHub: LiveHub
  window: BrowserWindow
  handled: ReadonlySet<string>
}): void {
  const { liveHub, window, handled } = deps
  const link = new HostLink({
    hub: liveHub,
    store: fileHostLinkStore(app.getPath('userData')),
    createSocket: openHostSocket,
    deviceName: `WingLog on ${hostname()}`,
    onStatus: (status) => {
      if (!window.isDestroyed()) window.webContents.send(IpcChannels.hostLinkStatus, status)
    }
  })
  registerHostLinkHandlers(ipcMain, { link, hub: liveHub, handled })
  runLogged('host link at launch', link.start())
  app.on('before-quit', () => link.stop())
}
