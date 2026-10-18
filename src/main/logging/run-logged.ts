/** Starting work the caller doesn't wait for, without losing its failure (coding-standards.md §6). */

import { logger } from './logger'

/**
 * Runs a promise nobody awaits (a timer tick, a window load, an event handler) and writes its
 * failure to main.log. Never rejects.
 *
 * @param context What the work is, for the log, e.g. "update check".
 * @param promise The work.
 */
export function runLogged(context: string, promise: Promise<unknown>): void {
  promise.catch((error: unknown) => logger.warn(`[${context}] failed: ${String(error)}`))
}
