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
import { listLanAddresses, type LanAddress } from './adapters'
import { LanController } from './LanController'
import { lanFlightSnapshot } from './lan-flight'
import { LanServer, type StaticFile } from './LanServer'
import { staticFilesFrom } from './static-files'

/** What the second screen needs from the rest of the app. */
export interface CreateLanDeps {
  db: WingLogDb
  liveHub: Pick<LiveHub, 'subscribe' | 'snapshot'>
  trackingController: Pick<TrackingController, 'getActive'>
  /** The built page's folder (`out/lan`). */
  pageFolder: string
  /** An acceptance test's own address to listen on, instead of the machine's (an unpackaged build only; see index.ts). */
  testAddress?: string
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
  pageFolder,
  testAddress
}: CreateLanDeps): LanController {
  // The page is read from disk the first time a device asks for it, not at every launch.
  let files: ((path: string) => StaticFile | null) | undefined
  const server = new LanServer({
    hub: liveHub,
    commands: {},
    devices: {
      add: (name, tokenHash) => addLanDevice(db, name, tokenHash, new Date().toISOString()),
      find: (tokenHash) => findActiveLanDevice(db, tokenHash),
      touch: (id) => touchLanDevice(db, id, new Date().toISOString())
    },
    flight: () => lanFlightSnapshot(db, trackingController.getActive()?.flightId),
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
