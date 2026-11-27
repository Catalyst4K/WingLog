import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { IpcChannels } from '@shared/ipc'
import { appCapabilities } from '@shared/run-mode'
import { createDb, type WingLogDb } from '../db/client'
import { createAircraft } from '../db/aircraft-repo'
import { createFlight } from '../db/flight-repo'
import { getRunMode, getSetting, setOpenConnectOnStart, setRunMode } from '../db/settings-repo'
import { registerRunModeHandlers } from './run-mode-handlers'
import { fakeIpc } from './fake-ipc'

describe('run mode IPC handlers', () => {
  let db: WingLogDb

  beforeEach(() => {
    db = createDb(':memory:').db
    migrate(db, { migrationsFolder: 'drizzle' })
  })

  const relaunch = vi.fn()
  let tracking = false

  function register(multiDevice: boolean, canHost: boolean): ReturnType<typeof fakeIpc>['invoke'] {
    relaunch.mockClear()
    const ipc = fakeIpc()
    registerRunModeHandlers(ipc.ipcMain, {
      db,
      capabilities: appCapabilities(getRunMode(db), multiDevice, canHost),
      flightActive: () => tracking,
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

  describe('Use another PC’s sim and Restart now (Add a device on a sim PC)', () => {
    beforeEach(() => {
      tracking = false
    })

    it('switches to a client, asks the next launch to open Connect to a sim PC, and restarts, in one step', () => {
      const invoke = register(true, true)
      expect(invoke(IpcChannels.appUseAnotherPcSimAndRestart)).toBe('restarting')
      expect(getRunMode(db)).toBe('client')
      expect(relaunch).toHaveBeenCalledTimes(1)
      // The next launch is a client: it reads the request once, and clears it.
      const next = register(true, true)
      expect(next(IpcChannels.appTakeOpenConnectOnStart)).toBe(true)
      expect(next(IpcChannels.appTakeOpenConnectOnStart)).toBe(false)
      expect(getSetting(db, 'openConnectOnStart')).toBeUndefined()
    })

    it('changes nothing and does not restart while a flight is being tracked', () => {
      tracking = true
      expect(register(true, true)(IpcChannels.appUseAnotherPcSimAndRestart)).toBe('flight-active')
      expect(getRunMode(db)).toBeNull()
      expect(getSetting(db, 'openConnectOnStart')).toBeUndefined()
      expect(relaunch).not.toHaveBeenCalled()
    })

    it('changes nothing and does not restart while a flight is loaded with Fly but not yet tracked', () => {
      const aircraftId = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' }).id
      createFlight(db, { aircraftId, depIcao: 'EGLL', arrIcao: 'VHHH' })
      expect(register(true, true)(IpcChannels.appUseAnotherPcSimAndRestart)).toBe('flight-active')
      expect(getRunMode(db)).toBeNull()
      expect(relaunch).not.toHaveBeenCalled()
    })

    it('is refused in a release build and on a computer that is already a client', () => {
      expect(() => register(false, true)(IpcChannels.appUseAnotherPcSimAndRestart)).toThrow('Only a sim PC')
      setRunMode(db, 'client')
      expect(() => register(true, true)(IpcChannels.appUseAnotherPcSimAndRestart)).toThrow('Only a sim PC')
      expect(getSetting(db, 'openConnectOnStart')).toBeUndefined()
      expect(relaunch).not.toHaveBeenCalled()
    })

    it('never sends a sim PC to Devices from a request left behind, and clears it', () => {
      setOpenConnectOnStart(db)
      expect(register(true, true)(IpcChannels.appTakeOpenConnectOnStart)).toBe(false)
      expect(getSetting(db, 'openConnectOnStart')).toBeUndefined()
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
