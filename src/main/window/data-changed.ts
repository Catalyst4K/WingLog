/**
 * Tells the window that data it may be showing changed behind its back, so its lists read again. On a client that is the end of a sync; on
 * the sim PC it is a change made by another WingLog (rows it pushed, a flight it flew or cancelled), which the window knows nothing about
 * because it did not make the change itself (winglog-backend's docs/plans/multi-device.md, finding F13).
 */

import { IpcChannels } from '@shared/ipc'

/** How long changes are gathered before the window is told, so a burst of rows is one message. */
export const DATA_CHANGED_DELAY_MS = 300

/** What the notifier needs from the main window. */
export interface NotifiedWindow {
  isDestroyed(): boolean
  webContents: { send(channel: string): void }
}

/**
 * @param window The main window.
 * @param delayMs How long to gather changes first.
 * @returns A function to call after data changed: the window is told once, a moment later, however many times it was called.
 */
export function dataChangedNotifier(
  window: NotifiedWindow,
  delayMs: number = DATA_CHANGED_DELAY_MS
): () => void {
  let timer: NodeJS.Timeout | null = null
  return () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      if (!window.isDestroyed()) window.webContents.send(IpcChannels.dataChanged)
    }, delayMs)
    timer.unref()
  }
}
