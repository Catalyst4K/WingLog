/**
 * What the renderer does with a failure it can't show the user: write it to main.log through IPC
 * (`appLogRendererError`), with what was being done (coding-standards.md §6). The renderer has
 * no log of its own, and a promise left floating only ever reached the devtools console.
 */

/**
 * Writes a failure to main.log. Never throws and never rejects: reporting must not become a
 * second failure.
 *
 * @param context What was being done, e.g. "settings: load weight unit".
 * @param error What failed.
 */
export function reportError(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  try {
    window.winglog.appLogRendererError(context, message).catch(() => undefined) // the log itself failed: nothing left to tell
  } catch {
    // No IPC (a test without it, or the window closing): nothing left to tell.
  }
}

/**
 * Runs a promise the caller doesn't wait for, reporting it if it fails. For loads started on
 * mount and other fire-and-forget calls.
 *
 * @param context What it does, for the log.
 * @param promise The work.
 */
export function runAsync(context: string, promise: Promise<unknown>): void {
  promise.catch((error: unknown) => reportError(context, error))
}

/**
 * Wraps an async event handler so React gets a plain function and a failure is reported.
 * Handlers that show their own error keep catching inside; this catches what gets past them.
 *
 * @param context What the handler does, for the log.
 * @param handler The async handler.
 * @returns A handler that returns nothing.
 */
export function asyncHandler<A extends unknown[]>(
  context: string,
  handler: (...args: A) => Promise<unknown>
): (...args: A) => void {
  return (...args) => runAsync(context, handler(...args))
}
