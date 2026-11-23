import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { IpcChannels } from '@shared/ipc'
import { appCapabilities } from '@shared/run-mode'
import { createDb, type WingLogDb } from '../db/client'
import { getRunMode, getSetting, setRunMode } from '../db/settings-repo'
import { registerRunModeHandlers } from './run-mode-handlers'
import { fakeIpc } from './fake-ipc'

describe('run mode IPC handlers', () => {
  let db: WingLogDb

  beforeEach(() => {
    db = createDb(':memory:').db
    migrate(db, { migrationsFolder: 'drizzle' })
  })

  const relaunch = vi.fn()

  function register(multiDevice: boolean, canHost: boolean): ReturnType<typeof fakeIpc>['invoke'] {
    relaunch.mockClear()
    const ipc = fakeIpc()
    registerRunModeHandlers(ipc.ipcMain, {
      db,
      capabilities: appCapabilities(getRunMode(db), multiDevice, canHost),
      relaunch
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

  describe('Use another PC’s sim (Add a device on a sim PC)', () => {
    it('makes the next launch a client that opens Connect to a sim PC, once', () => {
      const invoke = register(true, true)
      expect(invoke(IpcChannels.appTakeOpenConnectOnStart)).toBe(false)
      invoke(IpcChannels.settingsUseAnotherPcSim)
      expect(getRunMode(db)).toBe('client')
      // The next launch reads the request and clears it.
      const next = register(true, true)
      expect(next(IpcChannels.appTakeOpenConnectOnStart)).toBe(true)
      expect(next(IpcChannels.appTakeOpenConnectOnStart)).toBe(false)
      expect(getSetting(db, 'openConnectOnStart')).toBeUndefined()
    })

    it('is refused in a release build and on a computer that is already a client', () => {
      expect(() => register(false, true)(IpcChannels.settingsUseAnotherPcSim)).toThrow('Only a sim PC')
      setRunMode(db, 'client')
      expect(() => register(true, true)(IpcChannels.settingsUseAnotherPcSim)).toThrow('Only a sim PC')
      expect(getSetting(db, 'openConnectOnStart')).toBeUndefined()
    })

    it('restarts only when the run mode chosen for the next launch differs from this run’s', () => {
      const invoke = register(true, true)
      expect(() => invoke(IpcChannels.appRestartForRunMode)).toThrow('No run mode change')
      invoke(IpcChannels.settingsSetRunMode, 'host')
      expect(() => invoke(IpcChannels.appRestartForRunMode)).toThrow('No run mode change')
      expect(relaunch).not.toHaveBeenCalled()
      invoke(IpcChannels.settingsUseAnotherPcSim)
      invoke(IpcChannels.appRestartForRunMode)
      expect(relaunch).toHaveBeenCalledTimes(1)
    })

    it('never restarts a release build', () => {
      setRunMode(db, 'client')
      expect(() => register(false, true)(IpcChannels.appRestartForRunMode)).toThrow('No run mode change')
      expect(relaunch).not.toHaveBeenCalled()
    })
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
