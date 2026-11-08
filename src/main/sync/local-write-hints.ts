/**
 * Tells whoever keeps this computer's data in step with another that something was just written (winglog-backend's
 * docs/plans/multi-device.md, Part 4). Every writer already calls `scheduleBackgroundSync` after a change, for cloud sync; this is the same
 * moment, for the twin link: a host tells its twins to pull, a client syncs with its host.
 */

import { lazy } from '@shared/lazy'

const listeners = lazy(() => new Set<() => void>())

/**
 * @param listener Called each time the local database was written to.
 * @returns A function that stops it.
 */
export function onLocalWrite(listener: () => void): () => void {
  listeners().add(listener)
  return () => listeners().delete(listener)
}

/** Says the local database was just written to. A failing listener never stops the others, or the write that called this. */
export function localWriteHappened(): void {
  for (const listener of listeners()) {
    try {
      listener()
    } catch {
      // A hint is best effort: the next sync finds the change anyway.
    }
  }
}
