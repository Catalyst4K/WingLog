import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { IpcChannels } from '@shared/ipc'
import { appCapabilities } from '@shared/run-mode'
import { createDb, type WingLogDb } from '../db/client'
import { getRunMode, setRunMode } from '../db/settings-repo'
import { registerRunModeHandlers } from './run-mode-handlers'
import { fakeIpc } from './fake-ipc'

describe('run mode IPC handlers', () => {
  let db: WingLogDb

  beforeEach(() => {
    db = createDb(':memory:').db
    migrate(db, { migrationsFolder: 'drizzle' })
  })

  function register(multiDevice: boolean, canHost: boolean): ReturnType<typeof fakeIpc>['invoke'] {
    const ipc = fakeIpc()
    registerRunModeHandlers(ipc.ipcMain, {
      db,
      capabilities: appCapabilities(getRunMode(db), multiDevice, canHost)
    })
    return ipc.invoke
  }

  it('says what this run is, decided from the saved choice at startup', () => {
    setRunMode(db, 'client')
    expect(register(true, true)(IpcChannels.appGetCapabilities)).toEqual({
      runMode: 'client',
      canHostSim: true,
      multiDevice: true
    })
  })

  it('stores a choice for the next launch without changing this run', () => {
    const invoke = register(true, true)
    expect(invoke(IpcChannels.settingsGetRunMode)).toBeNull()
    invoke(IpcChannels.settingsSetRunMode, 'client')
    expect(invoke(IpcChannels.settingsGetRunMode)).toBe('client')
    expect(invoke(IpcChannels.appGetCapabilities)).toMatchObject({ runMode: 'host' })
  })

  it('refuses a choice in a build without multi-device, and stores nothing', () => {
    const invoke = register(false, true)
    expect(() => invoke(IpcChannels.settingsSetRunMode, 'client')).toThrow('cannot be changed')
    expect(getRunMode(db)).toBeNull()
  })

  it('refuses a value that is not a run mode, and the host on a computer that cannot host', () => {
    const invoke = register(true, false)
    expect(() => invoke(IpcChannels.settingsSetRunMode, 'server')).toThrow('Unknown run mode')
    expect(() => invoke(IpcChannels.settingsSetRunMode, 42)).toThrow('Unknown run mode')
    expect(() => invoke(IpcChannels.settingsSetRunMode, 'host')).toThrow('cannot be the sim host')
    invoke(IpcChannels.settingsSetRunMode, 'client')
    expect(getRunMode(db)).toBe('client')
  })
})
