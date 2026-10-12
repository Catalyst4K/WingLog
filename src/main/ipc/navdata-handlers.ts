/**
 * Navdata IPC: runways, procedures, taxi networks and stands from the sim's facility data
 * (winglog-backend's docs/plans/navdata-without-navigraph.md). Every channel is a query
 * (coding-standards.md §9). The two refresh channels are the only ones that touch the sim, through
 * the provider's own short-lived SimConnect connection; the rest are cache reads, so a Dispatch
 * dropdown never blocks on a live SimConnect round-trip.
 */
import type { IpcMain } from 'electron'
import { IpcChannels, type NavdataProcedureKind } from '@shared/ipc'
import { logger } from '../logging/logger'
import type { NavdataProvider } from '../navdata/navdata-provider'

/**
 * A refresh that needs the sim: when the sim isn't running or is still loading, the cache keeps serving and the caller tries again
 * next time, so a failed attempt is an ordinary event to note at info level, not an error for Electron to log as a failed handler.
 *
 * @param icao The airport.
 * @param what What was being refreshed, for the log.
 * @param refresh The refresh.
 * @returns Resolves whether or not it worked.
 */
async function refreshQuietly(icao: string, what: string, refresh: () => Promise<void>): Promise<void> {
  try {
    await refresh()
  } catch (error) {
    logger.info(`[navdata] ${icao} ${what} not refreshed: ${String(error)}`)
  }
}

/**
 * Registers the navdata channels.
 *
 * @param ipcMain Electron's IPC.
 * @param deps The navdata provider, shared with tracking (which records the stand a flight
 *   parked on).
 */
export function registerNavdataHandlers(
  ipcMain: IpcMain,
  { navdataProvider }: { navdataProvider: NavdataProvider }
): void {
  ipcMain.handle(IpcChannels.navdataRefreshAirport, (_event, icao: string) =>
    refreshQuietly(icao, 'runways and procedures', () => navdataProvider.refreshAirport(icao))
  )
  ipcMain.handle(IpcChannels.navdataHasAirport, (_event, icao: string) => navdataProvider.hasAirport(icao))
  ipcMain.handle(IpcChannels.navdataListRunways, (_event, icao: string) => navdataProvider.listRunways(icao))
  ipcMain.handle(IpcChannels.navdataListSids, (_event, icao: string, runway?: string | null) =>
    navdataProvider.listSids(icao, runway)
  )
  ipcMain.handle(IpcChannels.navdataListStars, (_event, icao: string, runway?: string | null) =>
    navdataProvider.listStars(icao, runway)
  )
  ipcMain.handle(IpcChannels.navdataListApproaches, (_event, icao: string, runway?: string | null) =>
    navdataProvider.listApproaches(icao, runway)
  )
  ipcMain.handle(
    IpcChannels.navdataGetProcedureWaypoints,
    (
      _event,
      icao: string,
      kind: NavdataProcedureKind,
      identifier: string,
      runway?: string | null,
      transition?: string | null
    ) => navdataProvider.getProcedureWaypoints(icao, kind, identifier, runway, transition)
  )
  ipcMain.handle(IpcChannels.navdataRefreshTaxiNetwork, (_event, icao: string) =>
    refreshQuietly(icao, 'taxi network', () => navdataProvider.refreshTaxiNetwork(icao))
  )
  ipcMain.handle(IpcChannels.navdataHasTaxiNetwork, (_event, icao: string) =>
    navdataProvider.hasTaxiNetwork(icao)
  )
  ipcMain.handle(IpcChannels.navdataGetTaxiNetwork, (_event, icao: string) =>
    navdataProvider.getTaxiNetwork(icao)
  )
  ipcMain.handle(IpcChannels.navdataGetStands, (_event, icao: unknown) =>
    typeof icao === 'string' && /^[A-Z0-9]{3,4}$/i.test(icao)
      ? navdataProvider.getStands(icao.toUpperCase())
      : []
  )
}
