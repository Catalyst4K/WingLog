/** Builds the second-screen server and its controller from the app's real parts. */

import { networkInterfaces } from 'node:os'
import { allRoutines } from '@shared/gsx-routines'
import type { WingLogDb } from '../db/client'
import {
  addLanDevice,
  findActiveLanDevice,
  listLanDevices,
  revokeLanDevice,
  revokeLanDevicesOfKind,
  touchLanDevice
} from '../db/lan-device-repo'
import { listHiddenBuiltIns, listOwnRoutines } from '../db/gsx-routine-repo'
import {
  getAltitudeUnit,
  getAppLanguage,
  getBeyondAtcSettings,
  getGsxRemoteSettings,
  getTrackingSettings,
  getLanSettings,
  getMapLanguage,
  getTheme,
  getWeightUnit,
  getWindSpeedUnit,
  setLanSettings
} from '../db/settings-repo'
import type { LiveHub } from '../live/LiveHub'
import type { OnlineNetwork, ProcedureSelection, TrackingSettings } from '@shared/ipc'
import type { ProcedureSelectionStore } from '../procedures/ProcedureSelectionStore'
import type { TrackingController } from '../tracking/TrackingController'
import { listAirfields } from '../airports/airfields'
import type { SimFacilitiesProvider } from '../navdata/sim-facilities-provider'
import { listLanAddresses, type LanAddress } from './adapters'
import { defaultRouteAddress } from './default-route'
import { trackCommands } from '../live/commands'
import type { LiveCommand } from '@shared/live'
import { fetchMetars } from '../weather/metar-client'
import { LanController } from './LanController'
import { clearDeferredRows } from '../db/sync-deferred-repo'
import { getOnlineNetworkSettings } from '../online/online-settings'
import { twinOrigin, twinSyncDeviceQueries, twinSyncQueries } from './twin-sync'
import { twinFlightQueries, type FlightControl } from './twin-flight'
import { onLocalWrite } from '../sync/local-write-hints'
import { lanFlightKey, lanFlightSnapshot } from './lan-flight'
import { LanServer, type LanServerDeps, type StaticFile } from './LanServer'
import { PlannedRoutePublisher } from './PlannedRoutePublisher'
import { staticFilesFrom } from './static-files'
import type { HostIdentity, HostIdentityStore } from './host-identity-store'
import { logger } from '../logging/logger'

/** What the second screen needs from the rest of the app. */
export interface CreateLanDeps {
  db: WingLogDb
  /** The database file's path: where a twin's sync conflicts are logged, next to it. */
  dbPath: string
  /** What a twin may make this computer do with a flight (fly, start, finish, stop, cancel). */
  flightControl: FlightControl
  /** Called when another WingLog changed data here (rows it pushed, a flight it flew or cancelled): the window reads again. */
  onTwinChange?: () => void
  liveHub: Pick<LiveHub, 'subscribe' | 'snapshot' | 'publish'>
  trackingController: Pick<TrackingController, 'getActive' | 'on'>
  /** The procedure choice for the flight shown: the one every screen follows. */
  selection: Pick<ProcedureSelectionStore, 'current' | 'set' | 'on'>
  /** The cached taxi charts, stands and procedures a device's map and Procedures dialog show. */
  navdata: Pick<
    SimFacilitiesProvider,
    | 'hasTaxiNetwork'
    | 'getTaxiNetwork'
    | 'getStands'
    | 'listRunways'
    | 'listSids'
    | 'listStars'
    | 'listApproaches'
    | 'getProcedureWaypoints'
    | 'onAirportRefreshed'
  >
  /** The BeyondATC and GSX Remote commands a second screen may send (the same tables the window's own channels use). */
  addOnCommands: Partial<Record<LiveCommand, (...args: unknown[]) => void>>
  /** The live ATIS for the weather panel's airports, as the PC's own window asks for it (it checks the request). */
  atis: (requests: unknown) => Promise<unknown>
  /** BeyondATC's ATIS read fresh, for the BeyondATC page's ATIS button on a twin (the PC's own button reads it the same way). */
  beyondAtcAtis: () => Promise<unknown>
  /** The User-Agent METAR lookups send. */
  userAgent: string
  /** Where METAR lookups go: the real service unless an end-to-end test says otherwise (an unpackaged build only; see index.ts). */
  metarUrl?: string
  /** The OS language the PC reports, which its "system" language setting follows; the phone shows the same one. */
  systemLocale?: () => string
  /** The built page's folder (`out/lan`). */
  pageFolder: string
  /** An acceptance test's own address to listen on, instead of the machine's (an unpackaged build only; see index.ts). */
  testAddress?: string
  /** Where the sim PC keeps its TLS identity. Without one (tests that do not need twins) only phones can connect. */
  identityStore?: HostIdentityStore
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

/** The PC's own settings only a twin reads (`twinSettingsQueries`). */
export interface TwinSettings {
  /** Whether tracking starts and finishes a flight by itself on this PC. A twin shows both read only; only this PC changes them. */
  tracking(): TrackingSettings
  /** The online network chosen on this PC, or null for none. A twin reads it to offer filing on that network; it never changes it. */
  onlineNetwork(): OnlineNetwork | null
}

/** The PC's own settings and weather a device's pages read, as lookups. */
export interface LanLocalData {
  /** The unit and map-language settings, so the page shows figures as the PC does. */
  display(): unknown
  /** Whether GSX Remote and BeyondATC are switched on at the PC (their pages only show then). */
  addOns(): { gsxRemote: boolean; beyondAtc: boolean }
  /** The GSX routines a device may start: the built-ins, then the pilot's own. Read only; editing stays on the PC. */
  routines(): unknown
  /** Current METARs for airport codes. */
  metars(codes: unknown): Promise<unknown>
  /** The live ATIS for the weather panel's airports. Checks the request. */
  atis(requests: unknown): Promise<unknown>
  /** BeyondATC's ATIS, read fresh. */
  beyondAtcAtis(): Promise<unknown>
}

/**
 * The PC's own settings that only a twin reads, to show them (automatic start and finish) or to act on them (which network to file on).
 * A phone has no use for them and is refused them as if they did not exist (`TWIN_ONLY_QUERIES`). Read only: a twin never changes them.
 *
 * @param local The PC's settings.
 * @returns The queries table.
 */
export function twinSettingsQueries(local: TwinSettings): Record<string, (...args: unknown[]) => unknown> {
  return {
    'settings.tracking': () => local.tracking(),
    // Only the network's name: the member numbers stay on the PC.
    'settings.onlineNetwork': () => ({ network: local.onlineNetwork() })
  }
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
    'gsx.routines': () => local.routines(),
    'weather.metars': (codes) => {
      if (!Array.isArray(codes) || codes.length > MAX_METAR_CODES) throw new Error('Invalid airports')
      return local.metars(codes)
    },
    'online.atis': (requests) => local.atis(requests),
    'beyondatc.atis': () => local.beyondAtcAtis(),
    'taxi.has': (icao) => navdata.hasTaxiNetwork(icaoArg(icao)),
    // The PC fetches the shown flight's navdata itself (FlightNavdataFetcher); a device never makes it open a sim connection. The
    // lookups stay, answering at once, for pages that still ask.
    'taxi.refresh': (icao) => void icaoArg(icao),
    'taxi.get': (icao) => navdata.getTaxiNetwork(icaoArg(icao)),
    stands: (icao) => navdata.getStands(icaoArg(icao)),
    'navdata.refreshAirport': (icao) => void icaoArg(icao),
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
 * Forgets the rows kept for a device that was revoked (a twin that is gone does not come back to have them tried again). Separate from the
 * revoke so that the caller can drop the device's open sockets first: this write can fail, and the revoked device must not stay connected
 * because of it.
 *
 * @param db The database.
 * @param id The device.
 */
function forgetDevice(db: WingLogDb, id: number): void {
  clearDeferredRows(db, twinOrigin(id))
}

/**
 * @param db The database.
 * @returns What the server needs to add, find, touch and revoke the paired devices.
 */
function serverDevices(db: WingLogDb): LanServerDeps['devices'] {
  return {
    add: (name, tokenHash, kind) => addLanDevice(db, name, tokenHash, new Date().toISOString(), kind),
    find: (tokenHash) => findActiveLanDevice(db, tokenHash),
    touch: (id) => touchLanDevice(db, id, new Date().toISOString()),
    revoke: (id) => revokeLanDevice(db, id, new Date().toISOString()),
    forget: (id) => forgetDevice(db, id)
  }
}

/**
 * Loads the sim PC's identity for the server. A new one means every paired twin pinned another certificate, and its token travelled in the
 * clear, so each is revoked: it shows "certificate changed" and the pilot pairs it again. Phones are not affected. The new identity is
 * kept only after that, so a failure in between (the load throws, the server runs for phones only) leaves the old identity in place and the
 * next start makes a new one and revokes again.
 *
 * @param db The database.
 * @param store Where the identity is kept.
 * @returns The identity, or null when this computer cannot keep one safely.
 */
async function loadIdentityRevokingTwins(
  db: WingLogDb,
  store: HostIdentityStore
): Promise<HostIdentity | null> {
  const identity = await store.load()
  if (identity?.isNew) {
    const twins = listLanDevices(db).filter((device) => device.kind === 'twin')
    const revoked = revokeLanDevicesOfKind(db, 'twin', new Date().toISOString())
    for (const twin of twins) clearDeferredRows(db, twinOrigin(twin.id))
    logger.info(`[lan] made a new identity for the sim PC; ${revoked} paired twin(s) unpaired`)
    await store.save(identity)
  }
  return identity
}

/**
 * @param route The planned route publisher.
 * @param selection The procedure choice.
 * @param source Which kind of device sent the choice, for the log.
 * @returns What a device's choice does.
 */
export function chooseProcedures(
  route: Pick<PlannedRoutePublisher, 'publishedCount' | 'resend'>,
  selection: Pick<ProcedureSelectionStore, 'set'>,
  source: 'phone' | 'twin'
): { setProcedureSelection(chosen: ProcedureSelection): void } {
  return {
    setProcedureSelection: (chosen) => {
      const before = route.publishedCount
      selection.set(chosen, source)
      // A choice the PC already had changes nothing and so builds no new route: answer it with the current one, which is how the
      // device learns it was heard.
      if (route.publishedCount === before) route.resend()
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
  dbPath,
  flightControl,
  onTwinChange,
  liveHub,
  trackingController,
  selection,
  navdata,
  addOnCommands,
  atis,
  beyondAtcAtis,
  userAgent,
  metarUrl,
  systemLocale = () => 'en',
  pageFolder,
  testAddress,
  identityStore
}: CreateLanDeps): LanController {
  // The planned route of the flight shown, built here and pushed to the devices: built again whenever the choice, the flight or the
  // navdata it uses may have changed.
  const route = new PlannedRoutePublisher({
    db,
    hub: liveHub,
    navdata,
    activeFlightId: () => trackingController.getActive()?.flightId,
    chosenSelection: () => selection.current()
  })
  selection.on('changed', () => route.refresh())
  for (const event of ['started', 'stopped', 'completed'] as const)
    trackingController.on(event, () => route.refresh())
  navdata.onAirportRefreshed(() => route.refresh())
  route.refresh()
  // The page is read from disk the first time a device asks for it, not at every launch.
  let files: ((path: string) => StaticFile | null) | undefined
  const server = new LanServer({
    hub: liveHub,
    commands: {
      ...addOnCommands,
      ...trackCommands(chooseProcedures(route, selection, 'phone'))
    },
    // The same command from a Mac or other twin: the same checks, logged as the twin's.
    twinCommands: trackCommands(chooseProcedures(route, selection, 'twin')),
    devices: serverDevices(db),
    // Each kind of device has its own switch; the server runs while either is on, and refuses a token of a kind that is off.
    enabledKinds: () => {
      const settings = getLanSettings(db)
      return { screen: settings.enabled, twin: settings.twinEnabled }
    },
    deviceQueries: twinSyncDeviceQueries(db, dbPath, onTwinChange),
    queries: {
      ...twinSyncQueries(db),
      ...twinFlightQueries(flightControl, onTwinChange),
      ...twinSettingsQueries({
        tracking: () => getTrackingSettings(db),
        onlineNetwork: () => getOnlineNetworkSettings(db).network
      }),
      ...lanQueries(navdata, {
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
        routines: () => allRoutines(listOwnRoutines(db).routines, listHiddenBuiltIns(db)),
        metars: (codes) => fetchMetars(codes, userAgent, metarUrl),
        atis: (requests) => atis(requests),
        beyondAtcAtis: () => beyondAtcAtis()
      })
    },
    flightKey: () => lanFlightKey(db, trackingController.getActive()?.flightId),
    onFlightChanged: () => route.refresh(),
    flight: () => lanFlightSnapshot(db, trackingController.getActive()?.flightId, selection.current()),
    staticFile: (path) => (files ??= staticFilesFrom(pageFolder))(path),
    identity: identityStore ? () => loadIdentityRevokingTwins(db, identityStore) : undefined,
    now: () => Date.now()
  })
  // A write to this PC's database is a hint to the twins that they can sync.
  onLocalWrite(() => server.notifyTwins())
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
      revoke: (id) => revokeLanDevice(db, id, new Date().toISOString()),
      forget: (id) => forgetDevice(db, id)
    },
    now: () => Date.now()
  })
}
