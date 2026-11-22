/**
 * The order a client registers its IPC handlers in must not matter. Electron throws on a second handler for a channel, and a start-up that
 * throws opens no window at all (real incident, 2026-11-22: a Mac client failed every launch with "Attempted to register a second handler
 * for 'settings:get-tracking'", because the link took the channel over before the settings handlers had registered it).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { IpcChannels } from '@shared/ipc'
import { createDb, type WingLogDb } from './db/client'
import { LiveHub } from './live/LiveHub'
import { registerInertHandlers, trackHandledChannels } from './client-mode'
import type { HostLink } from './host-link/HostLink'
import { registerHostLinkHandlers } from './host-link/client-ipc'
import { registerSettingsHandlers } from './ipc/settings-handlers'
import { fakeIpc } from './ipc/fake-ipc'

vi.mock('./logging/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock('electron', () => ({ app: { getLocale: () => 'en-GB' } }))
vi.mock('./i18n', () => ({ setMainLanguage: vi.fn() }))

describe('a client registers its handlers in any order', () => {
  let db: WingLogDb
  beforeEach(() => {
    db = createDb(':memory:').db
    migrate(db, { migrationsFolder: 'drizzle' })
  })

  /** The sim PC's answer to the tracking lookup: not what this computer's own database says (both switches on by default there). */
  const SIM_PC_TRACKING = { autoStart: false, autoFinish: false }

  function start() {
    const ipc = fakeIpc()
    const handled = trackHandledChannels(ipc.ipcMain)
    const link = { query: vi.fn().mockResolvedValue(SIM_PC_TRACKING) }
    const settings = () =>
      registerSettingsHandlers(ipc.ipcMain, {
        db,
        trackingController: { setAutoFinish: vi.fn() },
        trayController: { sync: vi.fn(), isAvailable: true }
      })
    const client = () =>
      registerHostLinkHandlers(ipc.ipcMain, {
        link: link as unknown as HostLink,
        hub: new LiveHub(),
        handled,
        // As startApp gives a client: its own procedure store, so the selection channels are answered too.
        ownSelection: { store: { set: vi.fn(), current: vi.fn() }, hostFlying: () => false }
      })
    return { ipc, handled, settings, client }
  }

  it('starts when the link takes a channel over before the settings handlers register it (the order startApp runs in)', async () => {
    const { ipc, handled, settings, client } = start()
    client()
    expect(settings).not.toThrow()
    expect(registerInertHandlers(ipc.ipcMain, handled)).not.toContain(IpcChannels.settingsGetTracking)
    expect(await ipc.invoke(IpcChannels.settingsGetTracking)).toEqual(SIM_PC_TRACKING)
  })

  it('starts when the settings handlers register first, and the link still has the answer', async () => {
    const { ipc, settings, client } = start()
    settings()
    expect(client).not.toThrow()
    expect(await ipc.invoke(IpcChannels.settingsGetTracking)).toEqual(SIM_PC_TRACKING)
  })

  it('answers every channel it takes over exactly once, whichever local handlers were there first or come after', async () => {
    // The link's own channels and the two add-on settings are plain registrations a host's services make and a client never does.
    const notLocal: string[] = [
      IpcChannels.hostLinkGetStatus,
      IpcChannels.hostLinkPair,
      IpcChannels.hostLinkForget,
      IpcChannels.settingsGetGsxRemote,
      IpcChannels.settingsGetBeyondAtc
    ]
    const everyChannel = Object.values(IpcChannels).filter((channel) => !notLocal.includes(channel))
    for (const localFirst of [true, false]) {
      const { ipc, client } = start()
      const local = () => {
        for (const channel of everyChannel) if (!ipc.has(channel)) ipc.ipcMain.handle(channel, () => 'local')
      }
      if (localFirst) local()
      expect(client).not.toThrow()
      if (!localFirst) expect(local).not.toThrow()
      // The sim PC's lookup answers, never the local `'local'` stand-in, and none of the channels it took over lost its handler.
      expect(await ipc.invoke(IpcChannels.settingsGetTracking)).toEqual(SIM_PC_TRACKING)
      expect(await ipc.invoke(IpcChannels.trafficLayersGet)).not.toBe('local')
      for (const channel of [
        IpcChannels.navdataListRunways,
        IpcChannels.trafficSetAtcOn,
        IpcChannels.gsxRoutineStart
      ])
        expect(ipc.has(channel)).toBe(true)
    }
  })

  it('keeps the settings handlers that the link does not take over', () => {
    const { ipc, settings, client } = start()
    client()
    settings()
    expect(ipc.invoke(IpcChannels.settingsGetTheme)).toBeDefined()
    expect(ipc.has(IpcChannels.settingsSetTracking)).toBe(true)
  })
})
