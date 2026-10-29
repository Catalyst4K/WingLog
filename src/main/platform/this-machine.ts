/** The platform facts that need this machine's environment, for the dev scripts and the e2e tests that run outside Electron. */

import { homedir } from 'node:os'
import { msfsUserCfgPaths, userDataDirectory } from './paths'
import { currentPlatform } from './platform'

/**
 * @returns WingLog's data folder on this machine (where `winglog.db`, `logs` and `captures` are), or null when Windows has no `APPDATA` set.
 */
export function thisMachinesUserDataDirectory(): string | null {
  return userDataDirectory(currentPlatform(), process.env, homedir())
}

/**
 * @returns Where MSFS 2024's `UserCfg.opt` may be on this machine, in order; none off Windows.
 */
export function thisMachinesMsfsUserCfgPaths(): string[] {
  return msfsUserCfgPaths(currentPlatform(), process.env)
}
