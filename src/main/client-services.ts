/**
 * What a client runs instead of the host's services (winglog-backend's docs/plans/multi-device.md, Parts 2 and 4): the link to the sim PC's
 * WingLog, which republishes its live topics into this computer's hub and forwards the commands a phone may send, and the sync that keeps
 * this computer's fleet and logbook in step with the sim PC's.
 */
import { hostname } from 'node:os'
import { app, ipcMain, shell, type BrowserWindow } from 'electron'
import { IpcChannels } from '@shared/ipc'
import type { WingLogDb } from './db/client'
import { ownEpoch } from './db/sync-change-repo'
import { runLogged } from './logging/run-logged'
import type { LiveHub } from './live/LiveHub'
import { HostLink } from './host-link/HostLink'
import { followHostFlight, onSyncLanded, showHeldRoute } from './host-link/client-follow'
import { mapFlightTopic, type FlightMirror } from './host-link/flight-mirror'
import type { FlightRelay } from './host-link/flight-relay'
import { registerHostLinkHandlers } from './host-link/client-ipc'
import { registerClientLocalHandlers } from './host-link/client-local-handlers'
import { fileHostLinkStore } from './host-link/host-link-store'
import { LanSyncClient } from './host-link/lan-sync-client'
import { SYNC_AFTER_WRITE_MS, TwinSync } from './host-link/TwinSync'
import { syncTrackPoints } from './host-link/track-point-sync'
import { openHostSocket } from './host-link/ws-socket'
import type { ProcedureSelectionStore } from './procedures/ProcedureSelectionStore'
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
 * @param deps.mirror The flight the sim PC is tracking, as this computer's own screens read it.
 * @param deps.relay Where Fly, Start, Finish and Cancel go: to the sim PC.
 * @param deps.selection This computer's procedure store: it holds a choice only for a flight the sim PC is not flying.
 */
export function startClientServices(deps: {
  liveHub: LiveHub
  window: BrowserWindow
  handled: ReadonlySet<string>
  db: WingLogDb
  dbPath: string
  mirror: FlightMirror
  relay: FlightRelay
  selection: ProcedureSelectionStore
}): void {
  const { liveHub, window, handled, db, dbPath, mirror, relay, selection } = deps
  const sync = new TwinSync({
    db,
    dbPath,
    client: new LanSyncClient(
      (name, ...args) => link.query(name, ...args),
      () => ownEpoch(db)
    ),
    canSync: () => link.getStatus().state === 'connected',
    // The tracks of completed flights follow the flights, a page at a time, once.
    afterSync: (guard) =>
      syncTrackPoints(
        db,
        guard((name, ...args) => link.query(name, ...args))
      )
  })
  const link: HostLink = new HostLink({
    hub: liveHub,
    store: fileHostLinkStore(app.getPath('userData')),
    createSocket: openHostSocket,
    deviceName: `WingLog on ${hostname()}`,
    onStatus: (status) => {
      if (!window.isDestroyed()) window.webContents.send(IpcChannels.hostLinkStatus, status)
    },
    sync,
    // The sim PC's flight ids mean nothing here: its points are re-labelled with this computer's id for the same flight (by uuid).
    mapTopic: (topic, payload) => mapFlightTopic(mirror, topic, payload),
    onFlight: followHostFlight(mirror, selection)
  })
  registerHostLinkHandlers(ipcMain, {
    link,
    hub: liveHub,
    handled,
    ownSelection: { store: selection, hostFlying: () => mirror.hostTracking() }
  })
  // Answered from this computer: the GSX routines (its own rows, synced) and filing on VATSIM or IVAO (its own browser).
  registerClientLocalHandlers(ipcMain, { db, openExternal: (url) => shell.openExternal(url) })
  relay.bind(
    {
      run: () => sync.run(),
      connected: () => link.getStatus().state === 'connected',
      refusal: () => link.refusalText()
    },
    (name, ...args) => link.query(name, ...args)
  )
  // Each time a sync ends well the lists on screen can be read again, and the procedure store looks at its flight's row: rows may have come in.
  onSyncLanded(sync, () => {
    showHeldRoute(mirror, liveHub)
    selection.refresh()
    if (!window.isDestroyed()) window.webContents.send(IpcChannels.dataChanged)
  })
  // A change made here reaches the sim PC soon after.
  onLocalWrite(() => sync.syncSoon(SYNC_AFTER_WRITE_MS))
  runLogged('host link at launch', link.start())
  app.on('before-quit', () => {
    sync.stop()
    link.stop()
  })
}
