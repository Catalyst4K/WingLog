/** Builds the second-screen server and its controller from the app's real parts. */

import { networkInterfaces } from 'node:os'
import type { WingLogDb } from '../db/client'
import {
  addLanDevice,
  findActiveLanDevice,
  listLanDevices,
  revokeLanDevice,
  touchLanDevice
} from '../db/lan-device-repo'
import {
  getAltitudeUnit,
  getAppLanguage,
  getBeyondAtcSettings,
  getGsxRemoteSettings,
  getLanSettings,
  getMapLanguage,
  getTheme,
  getWeightUnit,
  getWindSpeedUnit,
  setLanSettings
} from '../db/settings-repo'
import type { LiveHub } from '../live/LiveHub'
import type { TrackingController } from '../tracking/TrackingController'
import { listAirfields } from '../airports/airfields'
import type { SimFacilitiesProvider } from '../navdata/sim-facilities-provider'
import { listLanAddresses, type LanAddress } from './adapters'
import { defaultRouteAddress } from './default-route'
import { trackCommands } from '../live/commands'
import type { LiveCommand } from '@shared/live'
import { fetchMetars } from '../weather/metar-client'
import { LanController } from './LanController'
import { lanFlightKey, lanFlightSnapshot } from './lan-flight'
import { LanServer, type StaticFile } from './LanServer'
import { PlannedRoutePublisher } from './PlannedRoutePublisher'
import { staticFilesFrom } from './static-files'

/** What the second screen needs from the rest of the app. */
export interface CreateLanDeps {
  db: WingLogDb
  liveHub: Pick<LiveHub, 'subscribe' | 'snapshot' | 'publish'>
  trackingController: Pick<
    TrackingController,
    'getActive' | 'getProcedureSelection' | 'setProcedureSelection' | 'on'
  >
  /** The cached taxi charts, stands and procedures a device's map and Procedures dialog show. */
  navdata: Pick<
    SimFacilitiesProvider,
    | 'hasTaxiNetwork'
    | 'refreshTaxiNetwork'
    | 'getTaxiNetwork'
    | 'getStands'
    | 'refreshAirport'
    | 'listRunways'
    | 'listSids'
    | 'listStars'
    | 'listApproaches'
    | 'getProcedureWaypoints'
    | 'onAirportRefreshed'
  >
  /** The BeyondATC and GSX Remote commands a second screen may send (the same tables the window's own channels use). */
  addOnCommands: Partial<Record<LiveCommand, (...args: unknown[]) => void>>
  /** The User-Agent METAR lookups send. */
  userAgent: string
  /** The OS language the PC reports, which its "system" language setting follows; the phone shows the same one. */
  systemLocale?: () => string
  /** The built page's folder (`out/lan`). */
  pageFolder: string
  /** An acceptance test's own address to listen on, instead of the machine's (an unpackaged build only; see index.ts). */
  testAddress?: string
}

/**
 * @param value A lookup argument from a device.
 * @returns The airport code when it is 3 or 4 letters or digits.
 * @throws When it is anything else.
 */
function icaoArg(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z0-9]{3,4}$/.test(value)) throw new Error('Invalid airport')
  return value
}

/**
 * @param value A runway, procedure or transition name from a device.
 * @returns The name when it is a short string, or null when it is null or absent.
 * @throws When it is anything else.
 */
function nameArg(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || value.length === 0 || value.length > 40) throw new Error('Invalid name')
  return value
}

/** The kinds of procedure a device may ask the legs of. */
const PROCEDURE_KINDS = ['sid', 'star', 'approach'] as const

/** The most airports one weather lookup may ask about. */
const MAX_METAR_CODES = 6

/** The PC's own settings and weather a device's pages read, as lookups. */
export interface LanLocalData {
  /** The unit and map-language settings, so the page shows figures as the PC does. */
  display(): unknown
  /** Whether GSX Remote and BeyondATC are switched on at the PC (their pages only show then). */
  addOns(): { gsxRemote: boolean; beyondAtc: boolean }
  /** Current METARs for airport codes. */
  metars(codes: unknown): Promise<unknown>
}

/**
 * The read-only lookups a device may ask for: the airfield list, an airport's taxi chart, stands, runways and procedures by its code,
 * the PC's unit settings, which add-ons are on, and weather.
 *
 * @param navdata The cached navdata provider.
 * @param local The PC's settings and weather.
 * @returns The queries table.
 */
export function lanQueries(
  navdata: CreateLanDeps['navdata'],
  local: LanLocalData
): Record<string, (...args: unknown[]) => unknown> {
  return {
    airfields: () => listAirfields(),
    'settings.display': () => local.display(),
    // Only whether they are on: the host and port stay on the PC.
    'settings.gsxRemote': () => ({ enabled: local.addOns().gsxRemote, host: '', port: 1 }),
    'settings.beyondAtc': () => ({ enabled: local.addOns().beyondAtc, host: '' }),
    'weather.metars': (codes) => {
      if (!Array.isArray(codes) || codes.length > MAX_METAR_CODES) throw new Error('Invalid airports')
      return local.metars(codes)
    },
    'taxi.has': (icao) => navdata.hasTaxiNetwork(icaoArg(icao)),
    'taxi.refresh': (icao) => navdata.refreshTaxiNetwork(icaoArg(icao)),
    'taxi.get': (icao) => navdata.getTaxiNetwork(icaoArg(icao)),
    stands: (icao) => navdata.getStands(icaoArg(icao)),
    'navdata.refreshAirport': (icao) => navdata.refreshAirport(icaoArg(icao)),
    'navdata.listRunways': (icao) => navdata.listRunways(icaoArg(icao)),
    'navdata.listSids': (icao, runway) => navdata.listSids(icaoArg(icao), nameArg(runway)),
    'navdata.listStars': (icao, runway) => navdata.listStars(icaoArg(icao), nameArg(runway)),
    'navdata.listApproaches': (icao, runway) => navdata.listApproaches(icaoArg(icao), nameArg(runway)),
    'navdata.procedureWaypoints': (icao, kind, identifier, runway, transition) => {
      const checked = PROCEDURE_KINDS.find((k) => k === kind)
      const name = nameArg(identifier)
      if (!checked || name === null) throw new Error('Invalid procedure')
      return navdata.getProcedureWaypoints(icaoArg(icao), checked, name, nameArg(runway), nameArg(transition))
    }
  }
}

/**
 * The second-screen controller, wired to the database, the live hub and the machine's network. A device may send only the commands in the
 * remote-safe tables (`live/commands.ts`): BeyondATC, GSX Remote and choosing procedures.
 *
 * @param deps The database, hub, tracking and page folder.
 * @returns The controller; call `init()` to start the server if it was left on.
 */
export function createLan({
  db,
  liveHub,
  trackingController,
  navdata,
  addOnCommands,
  userAgent,
  systemLocale = () => 'en',
  pageFolder,
  testAddress
}: CreateLanDeps): LanController {
  // The planned route of the flight shown, built here and pushed to the devices: built again whenever the choice, the flight or the
  // navdata it uses may have changed.
  const route = new PlannedRoutePublisher({
    db,
    hub: liveHub,
    navdata,
    activeFlightId: () => trackingController.getActive()?.flightId,
    chosenSelection: () => trackingController.getProcedureSelection()
  })
  for (const event of ['selectionChanged', 'started', 'stopped', 'completed'] as const)
    trackingController.on(event, () => route.refresh())
  navdata.onAirportRefreshed(() => route.refresh())
  route.refresh()
  // The page is read from disk the first time a device asks for it, not at every launch.
  let files: ((path: string) => StaticFile | null) | undefined
  const server = new LanServer({
    hub: liveHub,
    commands: {
      ...addOnCommands,
      ...trackCommands({
        setProcedureSelection: (selection) => {
          const before = route.publishedCount
          trackingController.setProcedureSelection(selection)
          // A choice the PC already had changes nothing and so builds no new route: answer it with the current one, which is how the
          // device learns it was heard.
          if (route.publishedCount === before) route.resend()
        }
      })
    },
    devices: {
      add: (name, tokenHash) => addLanDevice(db, name, tokenHash, new Date().toISOString()),
      find: (tokenHash) => findActiveLanDevice(db, tokenHash),
      touch: (id) => touchLanDevice(db, id, new Date().toISOString())
    },
    queries: lanQueries(navdata, {
      display: () => ({
        weightUnit: getWeightUnit(db),
        altitudeUnit: getAltitudeUnit(db),
        windSpeedUnit: getWindSpeedUnit(db),
        mapLanguage: getMapLanguage(db),
        appLanguage: getAppLanguage(db),
        theme: getTheme(db),
        systemLocale: systemLocale()
      }),
      addOns: () => ({
        gsxRemote: getGsxRemoteSettings(db).enabled,
        beyondAtc: getBeyondAtcSettings(db).enabled
      }),
      metars: (codes) => fetchMetars(codes, userAgent)
    }),
    flightKey: () => lanFlightKey(db, trackingController.getActive()?.flightId),
    onFlightChanged: () => route.refresh(),
    flight: () =>
      lanFlightSnapshot(
        db,
        trackingController.getActive()?.flightId,
        trackingController.getProcedureSelection()
      ),
    staticFile: (path) => (files ??= staticFilesFrom(pageFolder))(path),
    now: () => Date.now()
  })
  return new LanController({
    server,
    settings: { get: () => getLanSettings(db), set: (settings) => setLanSettings(db, settings) },
    addresses: (): LanAddress[] =>
      testAddress
        ? [{ adapter: 'Test network', address: testAddress, kind: 'physical' }]
        : listLanAddresses(networkInterfaces()),
    routeAddress: () => (testAddress ? Promise.resolve(null) : defaultRouteAddress()),
    devices: {
      list: () => listLanDevices(db),
      revoke: (id) => revokeLanDevice(db, id, new Date().toISOString())
    },
    now: () => Date.now()
  })
}
