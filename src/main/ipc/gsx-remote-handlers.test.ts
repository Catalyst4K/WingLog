import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { IpcChannels } from '@shared/ipc'
import { createDb, type WingLogDb } from '../db/client'
import { setGsxRemoteSettings } from '../db/settings-repo'
import { EMPTY_COMMAND_BAR, EMPTY_MENU } from '../gsx-remote/GsxRemoteService'
import { FakeServiceSocket } from '../net/fake-service-socket'
import { fakeIpc } from './fake-ipc'
import { registerGsxRemoteHandlers } from './gsx-remote-handlers'

const sockets = FakeServiceSocket.opened

describe('GSX Remote IPC handlers', () => {
  let db: WingLogDb
  const publish = vi.fn()

  beforeEach(() => {
    db = createDb(':memory:').db
    migrate(db, { migrationsFolder: 'drizzle' })
    sockets.length = 0
    publish.mockClear()
  })

  it('stays off by default, answering with empty state and ignoring commands', () => {
    const { ipcMain, invoke } = fakeIpc()
    registerGsxRemoteHandlers(ipcMain, { db, liveHub: { publish }, socketCtor: FakeServiceSocket })
    expect(sockets).toHaveLength(0)
    expect(invoke(IpcChannels.settingsGetGsxRemote)).toMatchObject({ enabled: false })
    expect(invoke(IpcChannels.gsxRemoteGetStatus)).toEqual({ state: 'disconnected', lastError: null })
    expect(invoke(IpcChannels.gsxRemoteGetServices)).toEqual([])
    expect(invoke(IpcChannels.gsxRemoteGetGateInfo)).toBeNull()
    expect(invoke(IpcChannels.gsxRemoteGetMenu)).toEqual(EMPTY_MENU)
    expect(invoke(IpcChannels.gsxRemoteGetPrompt)).toBeNull()
    expect(invoke(IpcChannels.gsxRemoteGetCommandBar)).toEqual(EMPTY_COMMAND_BAR)
    for (const [channel, ...args] of [
      [IpcChannels.gsxRemotePickMenu, 0],
      [IpcChannels.gsxRemoteSearch, 'fuel'],
      [IpcChannels.gsxRemoteToggleMenu],
      [IpcChannels.gsxRemoteSubmitPrompt, 1, '120'],
      [IpcChannels.gsxRemoteCancelPrompt, 1],
      [IpcChannels.gsxRemoteRunCommand, 'boarding']
    ] as [string, ...unknown[]][]) {
      expect(invoke(channel, ...args), channel).toBeUndefined()
    }
  })

  it("connects at startup when it's on, on GSX's default port unless one is set", () => {
    setGsxRemoteSettings(db, { enabled: true, host: 'localhost', port: null })
    registerGsxRemoteHandlers(fakeIpc().ipcMain, { db, liveHub: { publish }, socketCtor: FakeServiceSocket })
    setGsxRemoteSettings(db, { enabled: true, host: '192.168.1.20', port: 8750 })
    registerGsxRemoteHandlers(fakeIpc().ipcMain, { db, liveHub: { publish }, socketCtor: FakeServiceSocket })
    expect(sockets.map((s) => s.url)).toEqual(['ws://localhost:8744/', 'ws://192.168.1.20:8750/'])
  })

  it('reconnects when its settings are saved, publishes its status live, and closes on quit', () => {
    const { ipcMain, invoke } = fakeIpc()
    const devDiagnostics = { attachGsx: vi.fn() }
    const remote = registerGsxRemoteHandlers(ipcMain, {
      db,
      liveHub: { publish },
      devDiagnostics,
      socketCtor: FakeServiceSocket
    })
    invoke(IpcChannels.settingsSetGsxRemote, { enabled: true, host: 'localhost', port: 8744 })
    expect(sockets.map((s) => s.url)).toEqual(['ws://localhost:8744/'])
    expect(devDiagnostics.attachGsx).toHaveBeenCalledTimes(1)
    sockets[0].open()
    expect(publish).toHaveBeenCalledWith('gsxRemoteStatus', expect.objectContaining({ state: 'connected' }))
    expect(invoke(IpcChannels.gsxRemoteGetStatus)).toMatchObject({ state: 'connected' })

    invoke(IpcChannels.settingsSetGsxRemote, { enabled: true, host: 'localhost', port: 8745 })
    expect(sockets[0].closed).toBe(true)
    expect(sockets[1].url).toBe('ws://localhost:8745/')

    remote.stop()
    expect(sockets[1].closed).toBe(true)
  })
})
