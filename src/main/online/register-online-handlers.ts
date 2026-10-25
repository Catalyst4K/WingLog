/**
 * Starts the online-network feed service and registers its IPC channels (winglog-backend docs/plans/vatsim-build.md, Step 1b).
 *
 * Channel kinds (coding-standards.md §9): the traffic and the layers are **live** (published to LiveHub, with a getter here for a
 * window's first render), the traffic switch is a **command** (also in the table a second screen may send), and the settings are
 * **queries**. Saving the settings restarts the feed service's decisions at once.
 */
import type { IpcMain } from 'electron'
import { IpcChannels } from '@shared/ipc'
import type { LatLon } from '@shared/geo'
import { getAirportCoords } from '../airports/airport-search'
import { getFlight } from '../db/flight-repo'
import { setFlightOnline } from './flight-online'
import type { WingLogDb } from '../db/client'
import { dispatchCommand, trafficCommands, type CommandTable, type TrafficCommand } from '../live/commands'
import type { LiveHub } from '../live/LiveHub'
import { logger } from '../logging/logger'
import { shownFlightOf } from '../navdata/wire-flight-navdata'
import type { SimConnectSource } from '../sim/SimConnectSource'
import type { TrackingController } from '../tracking/TrackingController'
import type { FeedUrls } from './feed-urls'
import { NetworkFeedService } from './NetworkFeedService'
import {
  getOnlineNetworkSettings,
  getPretendCallsign,
  getTrafficSwitches,
  setPretendCallsign,
  setOnlineNetworkSettings,
  setTrafficSwitches
} from './online-settings'

/** What the online-network feed needs. */
export interface OnlineHandlerDeps {
  db: WingLogDb
  liveHub: Pick<LiveHub, 'publish' | 'snapshot'>
  sim: Pick<SimConnectSource, 'on' | 'getLastTelemetry'>
  trackingController: Pick<TrackingController, 'on' | 'getActive'>
  /** The app's version, for the User-Agent. */
  appVersion: string
  /** True in the dev build only: "Pretend I am this pilot" is honoured nowhere else. */
  isDevBuild: boolean
  /** Where the feeds are (the real addresses, or the end-to-end test server's). */
  urls: FeedUrls
}

/**
 * @param deps The database, sim, tracking and live hub.
 * @returns A function giving where to centre the traffic: the aircraft's position while the sim is connected, otherwise the departure
 *   airport of the flight shown, otherwise null.
 */
function centreOf(deps: Pick<OnlineHandlerDeps, 'db' | 'sim' | 'trackingController'>): () => LatLon | null {
  return () => {
    const telemetry = deps.sim.getLastTelemetry()
    if (telemetry) return { lat: telemetry.latitude, lon: telemetry.longitude }
    const flight = shownFlightOf(deps.db, deps.trackingController.getActive()?.flightId)
    return flight?.depIcao ? getAirportCoords(flight.depIcao) : null
  }
}

/**
 * @param deps The database, tracking and the sim.
 * @returns The flight being tracked, as its filed airports, or null when none is.
 */
function trackedFlightOf(
  deps: Pick<OnlineHandlerDeps, 'db' | 'trackingController'>
): { departure: string; arrival: string; alternate: string | null } | null {
  const id = deps.trackingController.getActive()?.flightId
  const flight = id === undefined ? undefined : getFlight(deps.db, id)
  return flight ? { departure: flight.depIcao, arrival: flight.arrIcao, alternate: flight.altnIcao } : null
}

/**
 * Starts the feed service and registers the channels.
 *
 * @param ipcMain Electron's IPC.
 * @param deps The database, hub, sim, tracking, app version and feed addresses.
 * @returns `stop`, to end the service on quit, and the traffic command table for a second screen.
 */
export function registerOnlineHandlers(
  ipcMain: IpcMain,
  deps: OnlineHandlerDeps
): { stop: () => void; commands: CommandTable<TrafficCommand> } {
  const { db, liveHub, sim, trackingController } = deps
  const service = new NetworkFeedService({
    hub: liveHub,
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    timers: {
      set: (callback, ms) => setTimeout(callback, ms),
      clear: (handle) => clearTimeout(handle as NodeJS.Timeout)
    },
    urls: deps.urls,
    appVersion: deps.appVersion,
    settings: () => getOnlineNetworkSettings(db),
    switches: () => getTrafficSwitches(db),
    saveSwitches: (switches) => setTrafficSwitches(db, switches),
    centre: centreOf(deps),
    trackedFlight: () => trackedFlightOf(deps),
    isAirborne: () => sim.getLastTelemetry()?.onGround === false,
    pretendCallsign: () => (deps.isDevBuild ? getPretendCallsign(db) : null),
    log: logger
  })
  sim.on('telemetry', () => service.onPositionChanged())
  trackingController.on('started', () => {
    service.resetOnlineSeen()
    service.refresh()
  })
  trackingController.on('stopped', () => {
    service.resetOnlineSeen()
    service.refresh()
  })
  // A flight flown online keeps the network and callsign it was seen with while airborne.
  trackingController.on('completed', (flightId: number) => {
    const seen = service.takeOnlineSeen()
    if (seen) setFlightOnline(db, flightId, seen.network, seen.callsign)
    service.refresh()
  })

  ipcMain.handle(IpcChannels.networkTrafficGet, () => liveHub.snapshot().networkTraffic)
  ipcMain.handle(IpcChannels.trafficLayersGet, () => liveHub.snapshot().trafficLayers)
  ipcMain.handle(IpcChannels.onlineStatusGet, () => liveHub.snapshot().onlineStatus)
  ipcMain.handle(IpcChannels.networkControllersGet, () => liveHub.snapshot().networkControllers)
  ipcMain.handle(IpcChannels.onlineGetPretend, () => (deps.isDevBuild ? getPretendCallsign(db) : null))
  ipcMain.handle(IpcChannels.onlineSetPretend, (_event, callsign: unknown) => {
    if (!deps.isDevBuild) return
    setPretendCallsign(db, callsign)
    service.refresh()
  })
  ipcMain.handle(IpcChannels.settingsGetOnlineNetwork, () => getOnlineNetworkSettings(db))
  ipcMain.handle(IpcChannels.settingsSetOnlineNetwork, (_event, settings: unknown) => {
    setOnlineNetworkSettings(db, settings)
    service.refresh()
  })
  const commands = trafficCommands(service)
  ipcMain.handle(IpcChannels.trafficSetNetworkOn, (_event, ...args: unknown[]) =>
    dispatchCommand(commands, 'traffic.setNetworkOn', args)
  )
  service.start()
  return { stop: () => service.stop(), commands }
}
