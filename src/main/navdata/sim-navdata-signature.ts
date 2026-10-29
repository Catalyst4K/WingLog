/**
 * Which navigation data the sim holds, read from disk without asking the sim (winglog-backend docs/plans/navdata-cycle-check.md).
 *
 * A Navigraph subscriber's data is a package in the sim's Community folder whose `cycle.json` names the cycle, and whose
 * modified time is when the Hub installed it, which is the moment the sim's data changed. Everyone else has the sim's own data,
 * which states no cycle anywhere that was found, so it is "default" and the AIRAC calendar is all there is to go by. Everything read
 * here is a third party's file: size-limited, parsed as data, and a missing or odd file only ever means "default".
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { airacCycleNumber } from '@shared/airac'
import { thisMachinesMsfsUserCfgPaths } from '../platform/this-machine'
import type { NavdataStatus } from '@shared/ipc'

/** What the sim's navigation data is. */
export type NavdataSignature =
  | {
      source: 'navigraph'
      /** The AIRAC cycle, such as "2611". */
      cycle: string
      revision: string
      /** The last day the package is valid, as YYYY-MM-DD, when it says. */
      validTo: string | null
      /** When the package was installed, in epoch milliseconds. */
      installedAtMs: number
    }
  | { source: 'default' }

/** The disk, as far as this module reads it: injected so the tests need no sim and no Navigraph. */
export interface SignatureFiles {
  /** Where MSFS 2024's `UserCfg.opt` may be, in order. */
  userCfgPaths: string[]
  /** The file's text, or null when it is missing, unreadable or longer than `maxBytes`. */
  readText: (path: string, maxBytes: number) => string | null
  /** The file's modified time, or null when it is missing. */
  modifiedMs: (path: string) => number | null
}

const CFG_MAX_BYTES = 512 * 1024
const CYCLE_MAX_BYTES = 4 * 1024
/** How long a read is reused: an airport used twice in a second does not read the disk twice. */
const READ_TTL_MS = 30_000

/**
 * @param cfgText A `UserCfg.opt`.
 * @returns Its `InstalledPackagesPath`, or null when it has none or it is not an absolute path.
 */
export function parsePackagesPath(cfgText: string): string | null {
  const path = /^\s*InstalledPackagesPath\s+"([^"\r\n]+)"/m.exec(cfgText)?.[1]?.trim()
  return path && isAbsolute(path) ? path : null
}

/**
 * @param text A Navigraph `cycle.json`.
 * @param installedAtMs When the file was written.
 * @returns The signature it states, or null when it is not a Navigraph cycle file.
 */
export function parseNavigraphCycle(text: string, installedAtMs: number): NavdataSignature | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const file = parsed as Record<string, unknown>
  if (typeof file.cycle !== 'string' || !/^\d{4}$/.test(file.cycle)) return null
  if (!Number.isFinite(installedAtMs)) return null
  const revision = typeof file.revision === 'string' && /^\d{1,3}$/.test(file.revision) ? file.revision : '1'
  const validTo =
    typeof file.validityPeriod === 'string'
      ? (/\/(\d{4}-\d{2}-\d{2})$/.exec(file.validityPeriod)?.[1] ?? null)
      : null
  return { source: 'navigraph', cycle: file.cycle, revision, validTo, installedAtMs }
}

/**
 * @param files The disk.
 * @returns What the sim's navigation data is: Navigraph's package when it is installed, else the sim's own.
 */
export function readNavdataSignature(files: SignatureFiles): NavdataSignature {
  for (const cfgPath of files.userCfgPaths) {
    const cfg = files.readText(cfgPath, CFG_MAX_BYTES)
    const packages = cfg === null ? null : parsePackagesPath(cfg)
    if (!packages) continue
    const cycleFile = join(
      packages,
      'Community',
      'navigraph-nav-base',
      'ContentInfo',
      'navigraph-navdata',
      'cycle.json'
    )
    const text = files.readText(cycleFile, CYCLE_MAX_BYTES)
    const installedAtMs = files.modifiedMs(cycleFile)
    const found = text === null || installedAtMs === null ? null : parseNavigraphCycle(text, installedAtMs)
    if (found) return found
  }
  return { source: 'default' }
}

/**
 * The signature, read at most once in a while.
 *
 * @param files The disk.
 * @param now The clock.
 * @returns A function that gives the signature.
 */
export function createNavdataSignatureReader(
  files: SignatureFiles,
  now: () => Date = () => new Date()
): () => NavdataSignature {
  let last: { at: number; signature: NavdataSignature } | null = null
  return () => {
    const at = now().getTime()
    if (last && at - last.at < READ_TTL_MS) return last.signature
    last = { at, signature: readNavdataSignature(files) }
    return last.signature
  }
}

/**
 * @returns The disk as it is: reads that fail are "not there".
 */
export function realSignatureFiles(): SignatureFiles {
  return {
    userCfgPaths: thisMachinesMsfsUserCfgPaths(),
    readText: (path, maxBytes) => {
      try {
        if (!existsSync(path) || statSync(path).size > maxBytes) return null
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
    modifiedMs: (path) => {
      try {
        return statSync(path).mtimeMs
      } catch {
        return null
      }
    }
  }
}

/**
 * @param isPackaged Whether this is an installed build.
 * @param env The environment.
 * @returns The disk to read: the real one, except that an end-to-end run of an unpackaged build is pointed at a folder of its own for
 *   `UserCfg.opt`, so a test never reads this machine's own Navigraph install.
 */
export function signatureFilesFor(
  isPackaged: boolean,
  env: Record<string, string | undefined>
): SignatureFiles {
  const real = realSignatureFiles()
  const dir = isPackaged ? undefined : env.WINGLOG_E2E_MSFS_DIR
  return dir ? { ...real, userCfgPaths: [join(dir, 'UserCfg.opt')] } : real
}

/**
 * The moment before which cached navigation data cannot be what the sim has now. A Navigraph install is when the sim's data changed,
 * whatever the calendar says: a fetch before it holds the old cycle, and a fetch after it holds the new one, so the calendar
 * must not mark old data fresh on the day a cycle takes effect before the pilot has updated. For the sim's own data, which states
 * nothing, the calendar's cycle start is all there is.
 *
 * @param signature What the sim's data is.
 * @param calendarCycleStartMs When the calendar's current cycle began.
 * @returns The cutoff, in epoch milliseconds.
 */
export function staleBeforeMs(signature: NavdataSignature, calendarCycleStartMs: number): number {
  return signature.source === 'navigraph' ? signature.installedAtMs : calendarCycleStartMs
}

/**
 * @param signature What the sim's data is.
 * @param now The moment.
 * @returns What the pilot is told: the data's cycle against the calendar's.
 */
export function navdataStatusOf(signature: NavdataSignature, now: Date): NavdataStatus {
  const calendarCycle = airacCycleNumber(now)
  if (signature.source === 'default')
    return { source: 'default', cycle: null, revision: null, validTo: null, calendarCycle, state: 'default' }
  return {
    source: 'navigraph',
    cycle: signature.cycle,
    revision: signature.revision,
    validTo: signature.validTo,
    calendarCycle,
    // A package installed early, ahead of its effective date, is not behind.
    state: Number(signature.cycle) < Number(calendarCycle) ? 'behind' : 'current'
  }
}
