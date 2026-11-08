/**
 * Keeps a client's database in step with the sim PC's (winglog-backend's docs/plans/multi-device.md, Part 4): one sync at a time (a hint
 * during one asks for another when it ends), a short wait after a write so a burst is one sync, and a status Settings can show. The work
 * is the cloud sync engine's, with cursors of its own so it never moves the cloud account's.
 */

import type { WingLogDb } from '../db/client'
import { logger } from '../logging/logger'
import { runLogged } from '../logging/run-logged'
import { runSync, type SyncClient } from '../sync/sync-engine'

/** What Settings shows of the sync. */
export interface TwinSyncStatus {
  state: 'idle' | 'syncing' | 'error'
  /** When the last sync finished without a problem, ISO text. */
  lastSyncedAt: string | null
}

/** The part of sync the link uses. */
export interface TwinSyncPort {
  /** Asks for a sync after a wait (a later ask moves it). */
  syncSoon(delayMs: number): void
  status(): TwinSyncStatus
  /** Called whenever the status changes. */
  onChange(listener: () => void): void
}

/** How long after a write a client syncs, in milliseconds. */
export const SYNC_AFTER_WRITE_MS = 2000

/** The sync between this computer and the sim PC. */
export class TwinSync implements TwinSyncPort {
  private current: TwinSyncStatus = { state: 'idle', lastSyncedAt: null }
  private running = false
  private again = false
  private waiting: { promise: Promise<boolean> } | null = null
  private timer: NodeJS.Timeout | null = null
  private readonly listeners: (() => void)[] = []

  /**
   * @param deps The database and its path (where conflicts are logged), and the client that reaches the sim PC.
   * @param deps.db The database.
   * @param deps.dbPath The database file's path.
   * @param deps.client The sync client over the link.
   * @param deps.canSync Whether the link is up: a sync asked for while it is not waits for the next time it comes up.
   * @param deps.afterSync Work to do once the tables are level, such as bringing the tracks of completed flights.
   */
  constructor(
    private readonly deps: {
      db: WingLogDb
      dbPath: string
      client: SyncClient
      canSync: () => boolean
      afterSync?: () => Promise<unknown>
    }
  ) {}

  status(): TwinSyncStatus {
    return this.current
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener)
  }

  syncSoon(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      runLogged('twin sync', this.run())
    }, delayMs)
    this.timer.unref()
  }

  /** Stops a sync that is waiting (the app is quitting). */
  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /**
   * Runs one sync now, or, when one is under way, again straight after it; resolves when the sync asked for has ended.
   * Never rejects: a failure is the status's error.
   *
   * @returns True when the sync ended well, false when the link is down or it failed.
   */
  async run(): Promise<boolean> {
    if (!this.deps.canSync()) return false
    if (this.running) {
      this.again = true
      return (await this.waiting?.promise) ?? false
    }
    this.running = true
    const waiting = this.startWaiting()
    this.set({ state: 'syncing', lastSyncedAt: this.current.lastSyncedAt })
    try {
      const result = await runSync(
        this.deps.db,
        this.deps.client,
        { email: 'twin', token: '' },
        this.deps.dbPath,
        'lan'
      )
      await this.deps.afterSync?.().catch((error: unknown) => {
        // The tables are in step; a track that could not come now is asked for again at the next sync.
        logger.warn('[twin-sync] could not bring the tracks of completed flights:', error)
      })
      this.set({ state: 'idle', lastSyncedAt: result.syncedAt })
    } catch (error) {
      logger.warn('[twin-sync] sync with the sim PC failed:', error)
      this.set({ state: 'error', lastSyncedAt: this.current.lastSyncedAt })
    } finally {
      this.running = false
    }
    const ok = this.current.state === 'idle'
    // A change made during this sync gets one more, and whoever asked during it hears that one's result.
    let result = ok
    if (this.again) {
      this.again = false
      result = await this.run()
    }
    waiting.settle(result)
    return result
  }

  /** @returns What those who ask during a sync wait on. */
  private startWaiting(): { settle: (ok: boolean) => void } {
    let settle: (ok: boolean) => void = () => {}
    const promise = new Promise<boolean>((resolve) => (settle = resolve))
    this.waiting = { promise }
    return { settle }
  }

  private set(next: TwinSyncStatus): void {
    this.current = next
    for (const listener of this.listeners) listener()
  }
}
