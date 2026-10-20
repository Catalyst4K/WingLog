/**
 * Puts the "Close WingLog?" question to the pilot as a dialog inside the app window (winglog-backend's docs/plans/tray.md),
 * not a Windows message box. Main asks; the renderer shows its own confirmation and sends the answer back.
 */

/** What the question needs from the window and the renderer. */
export interface CloseQuestionDeps {
  /** Tells the renderer to show the question. */
  send: () => void
  /** Whether the renderer is there to show it; false while it loads or after it is gone. */
  isRendererReady: () => boolean
  /** Brings the window forward, in case it is hidden in the tray or minimised. */
  showWindow: () => void
}

/** One question at a time, answered from the renderer. */
export class CloseQuestion {
  private pending: ((close: boolean) => void) | null = null

  constructor(private readonly deps: CloseQuestionDeps) {}

  /**
   * Asks whether to close WingLog.
   *
   * @returns True to close. With no renderer to ask, true, so a broken window can never trap the app open.
   */
  ask(): Promise<boolean> {
    if (!this.deps.isRendererReady()) return Promise.resolve(true)
    // Only one question is ever open: an earlier one still waiting is taken as "keep open".
    this.answer(false)
    this.deps.showWindow()
    return new Promise((resolve) => {
      this.pending = resolve
      this.deps.send()
    })
  }

  /**
   * The renderer's answer.
   *
   * @param close True if the pilot chose to close WingLog.
   */
  answer(close: boolean): void {
    const resolve = this.pending
    this.pending = null
    resolve?.(close)
  }
}
