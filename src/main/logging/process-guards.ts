/**
 * Errors nobody caught, written to main.log instead of Electron's default: a blocking error dialog
 * that stops the whole main process until someone clicks it. An overnight flight lost seven hours
 * of tracking to one of those (a full disk, 2026-10-16). WingLog keeps running; the log says what
 * happened.
 */

import { logger } from './logger'

/** The slice of `process` this uses. */
interface ProcessEvents {
  on(event: 'uncaughtException', listener: (error: Error) => void): unknown
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown
}

/**
 * @param target The process to guard.
 * @param log Where the errors go.
 */
export function installProcessGuards(
  target: ProcessEvents = process,
  log: (message: string) => void = (message) => logger.error(message)
): void {
  target.on('uncaughtException', (error) => log(`[main] uncaught exception: ${error.stack ?? String(error)}`))
  target.on('unhandledRejection', (reason) => log(`[main] unhandled rejection: ${String(reason)}`))
}
