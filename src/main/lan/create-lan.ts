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
import { getLanSettings, setLanSettings } from '../db/settings-repo'
import type { LiveHub } from '../live/LiveHub'
import type { TrackingController } from '../tracking/TrackingController'
import { listAirfields } from '../airports/airfields'
import type { SimFacilitiesProvider } from '../navdata/sim-facilities-provider'
import { listLanAddresses, type LanAddress } from './adapters'
import { trackCommands } from '../live/commands'
import { LanController } from './LanController'
import { lanFlightSnapshot } from './lan-flight'
import { LanServer, type StaticFile } from './LanServer'
import { staticFilesFrom } from './static-files'

/** What the second screen needs from the rest of the app. */
export interface CreateLanDeps {
  db: WingLogDb
  liveHub: Pick<LiveHub, 'subscribe' | 'snapshot'>
  trackingController: Pick<
    TrackingController,
    'getActive' | 'getProcedureSelection' | 'setProcedureSelection'
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
  >
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

/**
 * The read-only lookups a device may ask for: the airfield list, and an airport's taxi chart, stands, runways and procedures by its code.
 *
 * @param navdata The cached navdata provider.
 * @returns The queries table.
 */
export function lanQueries(
  navdata: CreateLanDeps['navdata']
): Record<string, (...args: unknown[]) => unknown> {
  return {
    airfields: () => listAirfields(),
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
 * The second-screen controller, wired to the database, the live hub and the machine's network. Phase 1 is view-only, so the server is
 * given no commands.
 *
 * @param deps The database, hub, tracking and page folder.
 * @returns The controller; call `init()` to start the server if it was left on.
 */
export function createLan({
  db,
  liveHub,
  trackingController,
  navdata,
  pageFolder,
  testAddress
}: CreateLanDeps): LanController {
  // The page is read from disk the first time a device asks for it, not at every launch.
  let files: ((path: string) => StaticFile | null) | undefined
  const server = new LanServer({
    hub: liveHub,
    commands: trackCommands(trackingController),
    devices: {
      add: (name, tokenHash) => addLanDevice(db, name, tokenHash, new Date().toISOString()),
      find: (tokenHash) => findActiveLanDevice(db, tokenHash),
      touch: (id) => touchLanDevice(db, id, new Date().toISOString())
    },
    queries: lanQueries(navdata),
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
    devices: {
      list: () => listLanDevices(db),
      revoke: (id) => revokeLanDevice(db, id, new Date().toISOString())
    },
    now: () => Date.now()
  })
}
