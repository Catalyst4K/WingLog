/**
 * Watches the room left on the drive WingLog keeps its data on, so a full disk is a warning on screen, not a lost flight (an
 * overnight flight lost seven hours of tracking to one, 2026-10-16). The result is a live topic: the desktop window and any
 * second screen show the same warning.
 */

import { EventEmitter } from 'node:events'
import { statfs } from 'node:fs/promises'
import type { StorageStatus } from '@shared/ipc'
import { logger } from '../logging/logger'
import { runLogged } from '../logging/run-logged'

const GIB = 1024 ** 3
/** Under this much free, the warning shows: a long flight's track, the launch backup and a download can use it up. */
export const LOW_BYTES = 5 * GIB
/** Under this, saving is about to fail, or already is. */
export const CRITICAL_BYTES = 1 * GIB
/** How often the free space is read. */
export const CHECK_INTERVAL_MS = 60_000

/**
 * @param freeBytes The free space, or null when it could not be read.
 * @returns The warning level for it. Unknown space is not a warning.
 */
export function levelFor(freeBytes: number | null): StorageStatus['level'] {
  if (freeBytes === null) return 'ok'
  if (freeBytes < CRITICAL_BYTES) return 'critical'
  return freeBytes < LOW_BYTES ? 'low' : 'ok'
}

export interface DiskSpaceMonitorOptions {
  /** A folder on the drive to watch: WingLog's data folder. */
  folder: string
  /** Reads the free space (bytes) of the drive holding a folder; the real one by default. */
  readFreeBytes?: (folder: string) => Promise<number>
  log?: (message: string) => void
}

/**
 * @param folder A folder on the drive.
 * @returns The bytes free to this user on that drive.
 */
async function freeBytesOf(folder: string): Promise<number> {
  const stats = await statfs(folder)
  return stats.bavail * stats.bsize
}

/**
 * Reads the free space on a schedule and says when it changes enough to matter.
 */
export class DiskSpaceMonitor extends EventEmitter<{ status: [StorageStatus] }> {
  private status: StorageStatus = { freeBytes: null, level: 'ok', saveFailing: false }
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly readFreeBytes: (folder: string) => Promise<number>
  private readonly log: (message: string) => void

  constructor(private readonly options: DiskSpaceMonitorOptions) {
    super()
    this.readFreeBytes = options.readFreeBytes ?? freeBytesOf
    this.log = options.log ?? ((message) => logger.warn(`[storage] ${message}`))
  }

  /**
   * @returns The latest status.
   */
  getStatus(): StorageStatus {
    return this.status
  }

  /** Checks now, then every minute. */
  start(): void {
    this.stop()
    runLogged('storage check', this.check())
    this.timer = setInterval(() => runLogged('storage check', this.check()), CHECK_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * Tracking's word that saving the flight's track is failing, or working again. A failure is a reason to look at the disk now.
   *
   * @param failing Whether saving is failing.
   */
  setSaveFailing(failing: boolean): void {
    if (failing === this.status.saveFailing) return
    this.update({ ...this.status, saveFailing: failing })
    if (failing) runLogged('storage check', this.check())
  }

  /**
   * Reads the free space and updates the status. Never throws: an unreadable drive is no warning.
   */
  async check(): Promise<void> {
    let freeBytes: number | null = null
    try {
      freeBytes = await this.readFreeBytes(this.options.folder)
    } catch (error) {
      this.log(`could not read the free space: ${String(error)}`)
    }
    this.update({ ...this.status, freeBytes, level: levelFor(freeBytes) })
  }

  /**
   * Keeps the new status and emits it when it matters: the level or the failing flag changed, or, while a warning shows, the figure
   * it shows (tenths of a GB) did.
   *
   * @param next The status to keep.
   */
  private update(next: StorageStatus): void {
    const was = this.status
    this.status = next
    const tenths = (bytes: number | null): number | null =>
      bytes === null ? null : Math.round(bytes / (GIB / 10))
    const changed =
      next.level !== was.level ||
      next.saveFailing !== was.saveFailing ||
      (next.level !== 'ok' && tenths(next.freeBytes) !== tenths(was.freeBytes))
    if (changed) this.emit('status', next)
  }
}
