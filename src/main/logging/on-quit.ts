/** Shutdown steps that each run even when an earlier one fails (coding-standards.md §6). */

import { logger } from './logger'

/** The part of Electron's `app` that `onQuit` needs. */
export interface QuitEmitter {
  on: (event: 'before-quit', listener: () => void) => unknown
}

/**
 * Registers one step to run when the app quits. Electron calls every `before-quit` listener in a
 * single emit, so a listener that throws would stop the ones after it; this one catches the
 * failure (thrown, or a rejected promise it returns) and writes it to main.log by name instead.
 * Steps run in the order they were registered.
 *
 * @param app Electron's `app`.
 * @param name What the step is, for the log, e.g. "sim stop".
 * @param step The work. May return a promise nobody waits for.
 */
export function onQuit(app: QuitEmitter, name: string, step: () => unknown): void {
  app.on('before-quit', () => {
    try {
      const result = step()
      if (result instanceof Promise) {
        result.catch((error: unknown) => logger.warn(`[quit: ${name}] failed: ${String(error)}`))
      }
    } catch (error) {
      logger.warn(`[quit: ${name}] failed: ${String(error)}`)
    }
  })
}
