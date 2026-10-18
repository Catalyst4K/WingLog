/**
 * Test support for the register<Area>Handlers modules: an ipcMain that records each handler, and
 * calls it as the renderer would. Used only by their tests.
 */
import type { IpcMain } from 'electron'

/** A handler as ipcMain.handle receives it. */
type Handler = (event: unknown, ...args: unknown[]) => unknown

/** The recording ipcMain, and a way to call a channel. */
export interface FakeIpc {
  ipcMain: IpcMain
  /** Calls the channel's handler. Throws if nothing registered it. */
  invoke: (channel: string, ...args: unknown[]) => unknown
  /** Whether anything registered the channel. */
  has: (channel: string) => boolean
}

/**
 * An ipcMain that records handlers.
 *
 * @returns The fake, with `invoke` to call a channel.
 */
export function fakeIpc(): FakeIpc {
  const handlers = new Map<string, Handler>()
  const ipcMain = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) }
  return {
    // eslint-disable-next-line no-restricted-syntax -- a test double that only has handle()
    ipcMain: ipcMain as unknown as IpcMain,
    invoke: (channel, ...args) => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`No handler for ${channel}`)
      return handler({}, ...args)
    },
    has: (channel) => handlers.has(channel)
  }
}
