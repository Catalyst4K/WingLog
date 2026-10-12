/**
 * The page has no Electron preload, but the shared map code reads a few lookups through `window.winglog` (airfield list, taxi charts,
 * stands). Each is asked of the PC over the link; anything else the page never uses answers "nothing here".
 */

import type { LanConnection } from './lan-connection'

/**
 * Installs the stand-in `window.winglog`.
 *
 * @param link The link to the PC, which answers the lookups.
 */
export function installWindowShim(link: Pick<LanConnection, 'query'>): void {
  const known: Record<string, (...args: never[]) => unknown> = {
    airportListAirfields: () => link.query('airfields'),
    navdataHasTaxiNetwork: (icao: string) => link.query('taxi.has', icao),
    // A chart the PC has not cached is fetched by the PC from the sim; if that cannot be done the chart is simply empty.
    navdataRefreshTaxiNetwork: (icao: string) =>
      link.query('taxi.refresh', icao).then(
        () => undefined,
        () => undefined
      ),
    navdataGetTaxiNetwork: (icao: string) => link.query('taxi.get', icao),
    navdataGetStands: (icao: string) => link.query('stands', icao),
    // The Procedures dialog: the same cached runways and procedures the PC's own window lists.
    navdataRefreshAirport: (icao: string) =>
      link.query('navdata.refreshAirport', icao).then(
        () => undefined,
        () => undefined
      ),
    navdataListRunways: (icao: string) => link.query('navdata.listRunways', icao),
    navdataListSids: (icao: string, runway?: string | null) =>
      link.query('navdata.listSids', icao, runway ?? null),
    navdataListStars: (icao: string, runway?: string | null) =>
      link.query('navdata.listStars', icao, runway ?? null),
    navdataListApproaches: (icao: string, runway?: string | null) =>
      link.query('navdata.listApproaches', icao, runway ?? null),
    navdataGetProcedureWaypoints: (
      icao: string,
      kind: string,
      identifier: string,
      runway?: string | null,
      transition?: string | null
    ) => link.query('navdata.procedureWaypoints', icao, kind, identifier, runway ?? null, transition ?? null),
    onBeyondAtcTranscript: () => () => undefined
  }
  const shim = new Proxy(known, {
    get: (target, name) => {
      if (typeof name === 'string' && name in target) return target[name]
      return () => Promise.resolve([])
    }
  })
  Object.defineProperty(window, 'winglog', { value: shim, configurable: true })
}
