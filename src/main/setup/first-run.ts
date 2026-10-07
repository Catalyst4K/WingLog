/**
 * The first-launch setup (winglog-backend's docs/plans/first-launch-setup.md): shown once
 * to a new install, never to someone upgrading with a fleet or logbook already, who gets a
 * one-off "what's new" note instead.
 */

import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import { isNull } from 'drizzle-orm'
import type { SetupContext, SetupState } from '@shared/ipc'
import type { WingLogDb } from '../db/client'
import { aircraft, flight } from '../db/schema'
import { getSetting, setSetting } from '../db/settings-repo'
import { defaultGsxReceiptsPath } from '../gsx/default-path'
import { BEYONDATC_PORT } from '../beyondatc/BeyondAtcService'

const SETUP_COMPLETED_KEY = 'setupCompleted'

function hasExistingData(db: WingLogDb): boolean {
  const anyAircraft = db.select({ id: aircraft.id }).from(aircraft).where(isNull(aircraft.deletedAt)).limit(1).all()
  if (anyAircraft.length > 0) return true
  return db.select({ id: flight.id }).from(flight).where(isNull(flight.deletedAt)).limit(1).all().length > 0
}

/**
 * Whether to show the setup now. An existing user upgrading is marked done straight away
 * (so this answers `whatsNew` exactly once), and a new user sees the setup until they
 * finish or close it.
 *
 * @param db The database.
 * @returns Whether to show the setup, and whether to show what's new.
 */
export function getSetupState(db: WingLogDb): SetupState {
  if (getSetting(db, SETUP_COMPLETED_KEY) === '1') return { show: false, whatsNew: false }
  if (hasExistingData(db)) {
    setSetupCompleted(db)
    return { show: false, whatsNew: true }
  }
  return { show: true, whatsNew: false }
}

/**
 * Records that the setup is done, so it isn't shown again.
 *
 * @param db The database.
 */
export function setSetupCompleted(db: WingLogDb): void {
  setSetting(db, SETUP_COMPLETED_KEY, '1')
}

/**
 * Whether something answers on host:port within the timeout. Only ever a local probe.
 *
 * @param host The host.
 * @param port The port.
 * @param timeoutMs How long to wait.
 * @returns True if it connected in time.
 */
export function isListening(host: string, port: number, timeoutMs = 600): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const done = (result: boolean): void => {
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/**
 * What the add-ons step shows: whether GSX's receipts folder exists and whether
 * BeyondATC is running right now. Nothing is switched on here; the user decides
 * (Callum, 2026-10-02: BeyondATC is always asked, never turned on automatically).
 *
 * @param probe The port check, injected for tests.
 * @returns The add-ons step's facts.
 */
export async function getSetupContext(probe: typeof isListening = isListening): Promise<SetupContext> {
  const gsxFolderPath = defaultGsxReceiptsPath()
  return {
    gsxFolderFound: gsxFolderPath !== null && existsSync(gsxFolderPath),
    gsxFolderPath,
    beyondAtcRunning: await probe('127.0.0.1', BEYONDATC_PORT)
  }
}
