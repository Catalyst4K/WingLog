/** Info lines a screen writes to main.log under a fixed tag, checked and rate-limited here, since the renderer is not trusted. */

import { RENDERER_INFO_TAGS } from '@shared/ipc'

/** How many lines are written in one window; more are dropped and counted. */
export const RENDERER_INFO_MAX_LINES = 40

/** How long a window lasts, in ms. */
export const RENDERER_INFO_WINDOW_MS = 10_000

/** Writes `[tag] message` lines, only for a known tag and within the rate. */
export class RendererInfoLog {
  private windowStart = 0
  private written = 0
  private dropped = 0

  /**
   * @param emit Writes one finished line to the log.
   * @param now The clock, epoch ms.
   */
  constructor(
    private readonly emit: (line: string) => void,
    private readonly now: () => number
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
    if (at - this.windowStart >= RENDERER_INFO_WINDOW_MS) {
      if (this.dropped > 0)
        this.emit(`[${tag}] ${this.dropped} lines dropped: too many in ${RENDERER_INFO_WINDOW_MS / 1000} s`)
      this.windowStart = at
      this.written = 0
      this.dropped = 0
    }
    if (this.written >= RENDERER_INFO_MAX_LINES) {
      this.dropped += 1
      return
    }
    this.written += 1
    this.emit(`[${tag}] ${message}`)
  }
}
