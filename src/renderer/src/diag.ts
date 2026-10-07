/**
 * Renderer side of the dev build's diagnostic log: a decision made in the UI (the taxi route
 * trace, a re-route) sent to main's `diag.log` (winglog-backend robustness/dev-build.md).
 * Does nothing in a normal build.
 */

/** Longest message sent, in characters; main cuts again on its side. */
const MAX_MESSAGE_CHARS = 4_000

/**
 * Sends one `[diag:map]` line to `diag.log`.
 *
 * @param message What happened.
 * @param data Anything JSON-serialisable, appended to the message.
 * @param isDevBuild Defaults to the build flag; a parameter so both builds can be tested.
 */
export function diagMap(message: string, data?: unknown, isDevBuild: boolean = __WINGLOG_DEV_BUILD__): void {
  if (!isDevBuild) return
  let line = message
  if (data !== undefined) {
    try {
      line += ` ${JSON.stringify(data)}`
    } catch {
      line += ' (unserialisable data)'
    }
  }
  // A diagnostic line that can't be delivered is not worth surfacing to the user.
  window.winglog.diagLog('map', line.slice(0, MAX_MESSAGE_CHARS)).catch(() => undefined)
}
