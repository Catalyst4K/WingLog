/** Info lines a screen writes to main.log under a fixed tag, checked and rate-limited here, since the renderer is not trusted. */

import { RENDERER_INFO_TAGS } from '@shared/ipc'

/** How many lines are written in one window; more are dropped and counted. */
export const RENDERER_INFO_MAX_LINES = 40

/** How long a window lasts, in ms. */
export const RENDERER_INFO_WINDOW_MS = 10_000

/** Runs a function after a delay; the default is a timer that does not keep the app alive. */
type Schedule = (run: () => void, delayMs: number) => void

/**
 * @param run What to run.
 * @param delayMs How long to wait.
 */
function defaultSchedule(run: () => void, delayMs: number): void {
  setTimeout(run, delayMs).unref()
}

/** Writes `[tag] message` lines, only for a known tag and within the rate. */
export class RendererInfoLog {
  private windowStart = 0
  private written = 0
  private dropped = 0
  private tag = ''

  /**
   * @param emit Writes one finished line to the log.
   * @param now The clock, epoch ms.
   * @param schedule Runs the summary of dropped lines when a window that dropped some ends, so it is said even if no later line comes.
   */
  constructor(
    private readonly emit: (line: string) => void,
    private readonly now: () => number,
    private readonly schedule: Schedule = defaultSchedule
  ) {}

  /**
   * Writes one line, unless the tag is not a known one or the window's lines are used up.
   *
   * @param tag What the screen sent as the tag; anything but a known tag is ignored.
   * @param message The line, already on one line and cut to length.
   */
  write(tag: unknown, message: string): void {
    if (typeof tag !== 'string' || !(RENDERER_INFO_TAGS as readonly string[]).includes(tag)) return
    const at = this.now()
    // A clock that stepped back opens a new window too, or the cap would hold for as long as the step.
    if (at < this.windowStart || at - this.windowStart >= RENDERER_INFO_WINDOW_MS) {
      this.flushDropped()
      this.windowStart = at
      this.written = 0
    }
    if (this.written >= RENDERER_INFO_MAX_LINES) {
      if (this.dropped === 0) this.schedule(() => this.flushDropped(), RENDERER_INFO_WINDOW_MS)
      this.dropped += 1
      this.tag = tag
      return
    }
    this.written += 1
    this.emit(`[${tag}] ${message}`)
  }

  /** Says how many lines were dropped, if any were, and starts counting again. */
  private flushDropped(): void {
    if (this.dropped === 0) return
    this.emit(`[${this.tag}] ${this.dropped} lines dropped: too many in ${RENDERER_INFO_WINDOW_MS / 1000} s`)
    this.dropped = 0
  }
}
