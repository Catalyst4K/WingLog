/**
 * Lookup IPC: searches of the vendored airport, airline and aircraft-type lists, and the online
 * lookups (registration, SimBrief airframes, METARs, exchange rates). Every channel is a query
 * (coding-standards.md §9).
 */
import { app, type IpcMain } from 'electron'
import { IpcChannels } from '@shared/ipc'import { fetchAircraftByRegistration } from '../aircraft-lookup/adsbdb-client'
import { searchAircraftTypes } from '../aircraft-lookup/icao-types'
import { fetchAirframesForType } from '../simbrief/simbrief-airframes'
import { createCustomAirframeFromShare } from '../simbrief/simbrief-generate'
import { searchAirports } from '../airports/airport-search'
import { listAirfields } from '../airports/airfields'
import { searchAirlines, findAirlineByIcao } from '../airlines/airline-search'
import { fetchMetars } from '../weather/metar-client'
import { fetchExchangeRate } from '../fx/fx-client'


/**
 * Registers the lookup channels.
 *
 * @param ipcMain Electron's IPC.
 */
export function registerLookupHandlers(ipcMain: IpcMain): void {

  ipcMain.handle(IpcChannels.aircraftLookupByRegistration, (_event, registration: string) =>
    fetchAircraftByRegistration(registration)
  )

  ipcMain.handle(IpcChannels.aircraftTypeSearch, (_event, query: string) => searchAircraftTypes(query))

  ipcMain.handle(IpcChannels.simbriefAirframesForType, (_event, icaoType: string) =>
    fetchAirframesForType(icaoType)
  )

  ipcMain.handle(IpcChannels.simbriefCreateCustomAirframe, (_event, shareUrl: string) =>
    createCustomAirframeFromShare(shareUrl)
  )

  ipcMain.handle(IpcChannels.airportSearch, (_event, query: string) => searchAirports(query))

  ipcMain.handle(IpcChannels.airportListAirfields, () => listAirfields())

  ipcMain.handle(IpcChannels.airlineSearch, (_event, query: string) => searchAirlines(query))

  ipcMain.handle(IpcChannels.airlineFindByIcao, (_event, icao: string) => findAirlineByIcao(icao))

  ipcMain.handle(IpcChannels.weatherGetMetars, (_event, icaoCodes: unknown) =>
    fetchMetars(icaoCodes, `WingLog/${app.getVersion()}`)
  )

  ipcMain.handle(IpcChannels.fxGetRate, (_event, targetCurrency: string, date?: string) =>
    fetchExchangeRate(targetCurrency, date)
  )
}
