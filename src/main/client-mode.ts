/**
 * What a client leaves out (winglog-backend's docs/plans/multi-device.md, Part 1). A client is a WingLog that is not the sim's host: it does
 * not connect to the sim, GSX or BeyondATC, does not follow the online networks and does not serve a second screen, so none of those services
 * start. Each of them registers its own IPC channels when it starts, so the channels it would have owned are answered here with an empty,
 * safe value instead, and a screen that asks one of them gets "nothing there" rather than an error.
 */
import type { IpcMain } from 'electron'
import { IpcChannels } from '@shared/ipc'
import { logger } from './logging/logger'

/**
 * The channels a handler is registered for, and the ones the sim PC's link has taken over (the "claimed" ones). Electron throws on a second
 * handler for a channel, so a claimed channel is never registered again: whatever local service registers it later is left out, and the
 * sim PC's answer stays. That makes the order a client registers its handlers in not matter.
 */
export class HandledChannels extends Set<string> {
  /** The channels a client answers from the sim PC. */
  readonly claimed = new Set<string>()
}

/**
 * Remembers every channel a handler is registered for, from now on.
 *
 * @param ipcMain Electron's IPC; its `handle` is wrapped, so everything registered after this call is seen.
 * @returns The channel names, which grow as handlers are registered.
 */
export function trackHandledChannels(ipcMain: IpcMain): HandledChannels {
  const handled = new HandledChannels()
  const original = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, listener) => {
    if (handled.claimed.has(channel)) {
      logger.info('[client] left out a local handler for', channel, 'because the sim PC answers it')
      return
    }
    handled.add(channel)
    original(channel, listener)
  }
  return handled
}

/** What a skipped service's settings read as: switched off, so the app shell and Settings see nothing to start. */
const INERT_ANSWERS: Record<string, unknown> = {
  [IpcChannels.settingsGetGsxRemote]: { enabled: false, host: '127.0.0.1', port: null },
  [IpcChannels.settingsGetBeyondAtc]: { enabled: false, host: '127.0.0.1' },
  [IpcChannels.beyondAtcGetAtis]: { state: 'unavailable', airports: [] },
  [IpcChannels.settingsGetOnlineNetwork]: {
    network: null,
    vatsimCid: null,
    ivaoVid: null,
    keepBeyondAtcOnline: false,
    simTrafficButton: true
  }
}

/**
 * Answers every channel nothing registered, so a client never fails a call to a service it does not run.
 *
 * @param ipcMain Electron's IPC.
 * @param handled The channels already registered (from `trackHandledChannels`).
 * @returns The channels answered here.
 */
export function registerInertHandlers(ipcMain: IpcMain, handled: ReadonlySet<string>): string[] {
  const answered: string[] = []
  for (const channel of Object.values(IpcChannels)) {
    if (handled.has(channel)) continue
    const answer = INERT_ANSWERS[channel]
    ipcMain.handle(channel, () => answer)
    answered.push(channel)
  }
  return answered
}
