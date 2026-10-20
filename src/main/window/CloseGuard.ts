/**
 * Asks before the window closes while a flight is being tracked (winglog-backend's docs/plans/tray.md), so a click meant to minimise
 * does not end the recording. Closing with no flight in progress is not held back, and neither is Windows shutting down.
 */

/** The close event, which can be cancelled. */
export interface CloseEventLike {
  preventDefault(): void
}

/** What the guard needs from the main window. */
export interface GuardedWindow {
  close(): void
  on(event: 'close', listener: (event: CloseEventLike) => void): void
  on(event: 'session-end', listener: () => void): void
}

/** What the guard is built from. */
export interface CloseGuardDeps {
  window: GuardedWindow
  /** Whether a flight is in progress: planned and loaded with Fly, or being tracked. */
  isFlightInProgress: () => boolean
  /** Asks the pilot; true to close WingLog. */
  confirmClose: () => Promise<boolean>
  /** Where a failure to ask is logged. */
  onError: (error: unknown) => void
}

/** Holds a close while a flight is in progress, until the pilot confirms. */
export class CloseGuard {
  private isConfirmed = false
  private isAsking = false

  constructor(private readonly deps: CloseGuardDeps) {}

  /** Starts listening to the window. */
  start(): void {
    this.deps.window.on('close', (event) => this.handleClose(event))
    // Windows is shutting down or logging off: a window that refuses to close would hold it up.
    this.deps.window.on('session-end', () => {
      this.isConfirmed = true
    })
  }

  private handleClose(event: CloseEventLike): void {
    if (this.isConfirmed || !this.deps.isFlightInProgress()) return
    event.preventDefault()
    if (this.isAsking) return
    this.isAsking = true
    this.deps
      .confirmClose()
      .then((close) => {
        if (!close) return
        this.isConfirmed = true
        this.deps.window.close()
      })
      .catch((error: unknown) => this.deps.onError(error))
      .finally(() => {
        this.isAsking = false
      })
  }
}
