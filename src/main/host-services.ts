/**
 * The services that belong to the computer the sim runs on: GSX Remote, BeyondATC, the online networks and the second screen
 * (winglog-backend's docs/plans/multi-device.md, Part 1). A client starts none of them, so startApp calls this only on a host.
 */
import { runLogged } from './logging/run-logged'
import { join } from 'node:path'
import { app, ipcMain, shell } from 'electron'
import { type WingLogDb } from './db/client'
import { getLiveFlight } from './db/flight-repo'
import { SimConnectService } from './sim/SimConnectService'
import { ReplaySimConnectService } from './sim/ReplaySimConnectService'
import { type ReplayedCapture } from './sim/replay-capture'
import { registerGsxRemoteHandlers } from './ipc/gsx-remote-handlers'
import { registerBeyondAtcHandlers } from './ipc/beyondatc-handlers'
import { registerLanHandlers } from './ipc/lan-handlers'
import { createLan } from './lan/create-lan'
import { shownFlightId } from './lan/lan-flight'
import { resolveFeedUrls } from './online/feed-urls'
import { registerAtcAreas } from './online/atc-areas-handlers'
import { resolveAreaSource } from './online/atc-areas-download'
import { registerOnlineHandlers } from './online/register-online-handlers'
import { resolveMetarUrl } from './weather/metar-client'
import { registerPrefileHandlers } from './online/register-prefile-handlers'
import { e2eBeyondAtcPort } from './beyondatc/BeyondAtcService'
import { LiveHub } from './live/LiveHub'
import { SimFacilitiesProvider } from './navdata/sim-facilities-provider'
import { TrackingController } from './tracking/TrackingController'
import { DevDiagnostics } from './diagnostics/dev-diagnostics'

/**
 * GSX Remote, and the GSX routines that run on its connection. A routine's data-entry guard needs the plan's zero fuel weight: the
 * flight a second screen would show.
 *
 * @param deps The database, LiveHub, diagnostics, the sim (and its replayed GSX stream in e2e) and tracking.
 * @returns GSX Remote's commands, for a second screen.
 */
function startGsxRemote(deps: {
  db: WingLogDb
  liveHub: LiveHub
  devDiagnostics: DevDiagnostics | undefined
  sim: SimConnectService | ReplaySimConnectService
  replayStreams: ReplayedCapture | undefined
  trackingController: TrackingController
}): ReturnType<typeof registerGsxRemoteHandlers> {
  const { db, liveHub, devDiagnostics, sim, replayStreams, trackingController } = deps
  const gsxRemote = registerGsxRemoteHandlers(ipcMain, {
    db,
    liveHub,
    devDiagnostics,
    socketCtor:
      process.env.WINGLOG_E2E_REPLAY_STREAMS === 'beyondatc' ? undefined : replayStreams?.gsx.socketCtor,
    telemetry: () => sim.getLastTelemetry(),
    plannedZfwKg: () => {
      const id = shownFlightId(db, trackingController.getActive()?.flightId)
      return (id === undefined ? undefined : getLiveFlight(db, id))?.zfwKg ?? null
    }
  })
  app.on('before-quit', () => gsxRemote.stop())
  return gsxRemote
}

/**
 * The online network's traffic (VATSIM or IVAO): off until a network is chosen and its switch turned on.
 *
 * @param deps The database, the live hub, the sim and tracking.
 * @returns The traffic command table and the ATIS lookup, for the second screen to use.
 */
function startOnlineNetwork(
  deps: Pick<
    Parameters<typeof registerOnlineHandlers>[1],
    'db' | 'liveHub' | 'sim' | 'trackingController'
  > & {
    beyondAtc: Pick<ReturnType<typeof registerBeyondAtcHandlers>, 'readAtis'>
  }
): Pick<ReturnType<typeof registerOnlineHandlers>, 'commands' | 'atisAt'> {
  const areas = registerAtcAreas(ipcMain, {
    db: deps.db,
    userDataDir: app.getPath('userData'),
    appVersion: app.getVersion(),
    source: resolveAreaSource(app.isPackaged, process.env)
  })
  const online = registerOnlineHandlers(ipcMain, {
    ...deps,
    beyondAtcAtis: deps.beyondAtc.readAtis,
    appVersion: app.getVersion(),
    isDevBuild: __WINGLOG_DEV_BUILD__,
    urls: resolveFeedUrls(app.isPackaged, process.env),
    atcAreas: areas.current
  })
  app.on('before-quit', () => {
    online.stop()
    areas.stop()
  })
  registerPrefileHandlers(ipcMain, { db: deps.db, openExternal: (url) => shell.openExternal(url) })
  return { commands: online.commands, atisAt: online.atisAt }
}

/**
 * The second screen (a phone or tablet in a browser): off until the pilot turns it on in Settings.
 *
 * @param deps The database, the live hub, tracking, navdata and the add-on commands a second screen may send.
 */
function startSecondScreen(
  deps: Pick<
    Parameters<typeof createLan>[0],
    'db' | 'liveHub' | 'trackingController' | 'selection' | 'navdata' | 'addOnCommands' | 'atis'
  >
): void {
  const lan = createLan({
    ...deps,
    userAgent: `WingLog/${app.getVersion()}`,
    metarUrl: resolveMetarUrl(app.isPackaged, process.env),
    systemLocale: () => app.getLocale(),
    pageFolder: join(__dirname, '../lan'),
    testAddress: app.isPackaged ? undefined : process.env.WINGLOG_E2E_LAN_ADDRESS
  })
  registerLanHandlers(ipcMain, { lan })
  runLogged('second screen at launch', lan.init())
  app.on('before-quit', () => runLogged('second screen stop', lan.stop()))
}

/**
 * The services that belong to the computer the sim runs on: GSX Remote, BeyondATC, the online networks and the second screen. A client
 * starts none of them (see startApp).
 *
 * @param deps The database, the live hub, diagnostics, the sim, tracking, navdata and the flight shown.
 */
export function startHostServices(deps: {
  db: WingLogDb
  liveHub: LiveHub
  devDiagnostics: DevDiagnostics | undefined
  sim: SimConnectService | ReplaySimConnectService
  replayStreams: ReplayedCapture | undefined
  trackingController: TrackingController
  navdataProvider: SimFacilitiesProvider
  selection: Parameters<typeof startSecondScreen>[0]['selection']
}): void {
  const { db, liveHub, devDiagnostics, sim, replayStreams, trackingController, navdataProvider } = deps
  const gsxRemote = startGsxRemote({ db, liveHub, devDiagnostics, sim, replayStreams, trackingController })
  const beyondAtc = registerBeyondAtcHandlers(ipcMain, {
    db,
    liveHub,
    trackingController,
    sim,
    listApproaches: (icao) => navdataProvider.listApproaches(icao),
    devDiagnostics,
    socketCtor: replayStreams?.beyondAtc.socketCtor,
    port: e2eBeyondAtcPort(process.env.WINGLOG_E2E_BEYONDATC_PORT)
  })
  app.on('before-quit', () => beyondAtc.stop())
  const onlineNetwork = startOnlineNetwork({ db, liveHub, sim, trackingController, beyondAtc })
  startSecondScreen({
    db,
    liveHub,
    trackingController,
    selection: deps.selection,
    navdata: navdataProvider,
    addOnCommands: { ...beyondAtc.commands, ...gsxRemote.commands, ...onlineNetwork.commands },
    atis: onlineNetwork.atisAt
  })
}
