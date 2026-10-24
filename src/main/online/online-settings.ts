/**
 * The online-network settings and the two shared traffic switches, kept in `app_setting`. Every value from the window is validated
 * here, since the renderer is not a security boundary. Plan: winglog-backend docs/plans/vatsim-build.md, Step 1a.
 */
import type { OnlineNetwork, OnlineNetworkSettings } from '@shared/ipc'
import type { WingLogDb } from '../db/client'
import { getSetting, setSetting } from '../db/settings-repo'

const NETWORK_KEY = 'onlineNetwork'
const VATSIM_CID_KEY = 'vatsimCid'
const IVAO_VID_KEY = 'ivaoVid'
const NETWORK_ON_KEY = 'trafficNetworkOn'
const SIM_ON_KEY = 'trafficSimOn'
const PRETEND_CALLSIGN_KEY = 'devPretendCallsign'
const KEEP_BEYONDATC_KEY = 'onlineKeepBeyondAtc'

/** A callsign: letters, digits, underscore and hyphen, at most 12. */
const CALLSIGN = /^[A-Za-z0-9_-]{1,12}$/

/** The member number: digits only, 1 to 10 of them. */
const MEMBER_NUMBER = /^\d{1,10}$/

/**
 * @param value A stored network name.
 * @returns The network, or null for anything else.
 */
function asNetwork(value: unknown): OnlineNetwork | null {
  return value === 'vatsim' || value === 'ivao' ? value : null
}

/**
 * @param value A member number from the window.
 * @returns The number, or null when it is null or empty.
 * @throws When it is anything else than 1 to 10 digits.
 */
function memberNumberOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || !MEMBER_NUMBER.test(value)) throw new Error('Invalid member number')
  return value
}

/**
 * @param db The database.
 * @returns The chosen network and the member numbers (none chosen by default).
 */
export function getOnlineNetworkSettings(db: WingLogDb): OnlineNetworkSettings {
  const cid = getSetting(db, VATSIM_CID_KEY)
  const vid = getSetting(db, IVAO_VID_KEY)
  return {
    network: asNetwork(getSetting(db, NETWORK_KEY)),
    vatsimCid: cid && MEMBER_NUMBER.test(cid) ? cid : null,
    ivaoVid: vid && MEMBER_NUMBER.test(vid) ? vid : null,
    keepBeyondAtcOnline: getSetting(db, KEEP_BEYONDATC_KEY) === '1'
  }
}

/**
 * Validates and stores the online-network settings.
 *
 * @param db The database.
 * @param settings As the window sent them: unchecked.
 * @throws When the network is not vatsim, ivao or null, or a member number is not 1 to 10 digits.
 */
export function setOnlineNetworkSettings(db: WingLogDb, settings: unknown): void {
  if (typeof settings !== 'object' || settings === null) throw new Error('Invalid online network settings')
  const record: Record<string, unknown> = { ...settings }
  const network = record.network
  if (network !== null && network !== 'vatsim' && network !== 'ivao') throw new Error('Invalid network')
  const cid = memberNumberOrNull(record.vatsimCid)
  const vid = memberNumberOrNull(record.ivaoVid)
  if (typeof record.keepBeyondAtcOnline !== 'boolean') throw new Error('Invalid setting')
  setSetting(db, KEEP_BEYONDATC_KEY, record.keepBeyondAtcOnline ? '1' : '0')
  setSetting(db, NETWORK_KEY, network ?? '')
  setSetting(db, VATSIM_CID_KEY, cid ?? '')
  setSetting(db, IVAO_VID_KEY, vid ?? '')
}

/**
 * @param db The database.
 * @returns The callsign the dev build takes to be the pilot, or null.
 */
export function getPretendCallsign(db: WingLogDb): string | null {
  const value = getSetting(db, PRETEND_CALLSIGN_KEY)
  return value && CALLSIGN.test(value) ? value : null
}

/**
 * Stores the dev build's "Pretend I am this pilot" callsign.
 *
 * @param db The database.
 * @param callsign As the window sent it: unchecked. Empty or null clears it.
 * @throws When it is not a callsign.
 */
export function setPretendCallsign(db: WingLogDb, callsign: unknown): void {
  if (callsign === null || callsign === undefined || callsign === '') {
    setSetting(db, PRETEND_CALLSIGN_KEY, '')
    return
  }
  if (typeof callsign !== 'string' || !CALLSIGN.test(callsign)) throw new Error('Invalid callsign')
  setSetting(db, PRETEND_CALLSIGN_KEY, callsign)
}

/**
 * @param db The database.
 * @returns Whether each traffic layer's shared switch is on (both off by default).
 */
export function getTrafficSwitches(db: WingLogDb): { networkOn: boolean; simOn: boolean } {
  return {
    networkOn: getSetting(db, NETWORK_ON_KEY) === '1',
    simOn: getSetting(db, SIM_ON_KEY) === '1'
  }
}

/**
 * Stores the traffic switches.
 *
 * @param db The database.
 * @param switches The new values.
 */
export function setTrafficSwitches(db: WingLogDb, switches: { networkOn: boolean; simOn: boolean }): void {
  setSetting(db, NETWORK_ON_KEY, switches.networkOn ? '1' : '0')
  setSetting(db, SIM_ON_KEY, switches.simOn ? '1' : '0')
}
