/**
 * What the backend answered when it refused a call, with the HTTP status kept as a number, so the caller decides what to do by the status and
 * not by matching the words of the message (winglog-backend's docs/plans/security-audit-v2.md, L6).
 */

/** A call the backend answered with an error status. `message` is the backend's own error text, or one that names the route and status. */
export class BackendError extends Error {
  /**
   * @param message The text to show.
   * @param status The HTTP status the backend answered with.
   */
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'BackendError'
  }
}

/**
 * @param err Whatever a sync call threw.
 * @returns True when the backend answered 401 to a sync call: the session in use is no longer valid, whatever the words of the answer.
 */
export function isSessionRefused(err: unknown): boolean {
  return err instanceof BackendError && err.status === 401
}
