import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { IpcChannels } from '@shared/ipc'
import { createDb, type WingLogDb } from '../db/client'
import { createAircraft } from '../db/aircraft-repo'
import { registerSettingsHandlers } from './settings-handlers'
import { fakeIpc } from './fake-ipc'

vi.mock('electron', () => ({ app: { getLocale: () => 'de-DE' } }))
const setMainLanguage = vi.fn()
vi.mock('../i18n', () => ({
  setMainLanguage: (setting: string, locale: string) => setMainLanguage(setting, locale)
}))
const getSetupContext = vi.fn()
vi.mock('../setup/first-run', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../setup/first-run')>()),
  getSetupContext: () => getSetupContext()
}))

describe('settings IPC handlers', () => {
  let db: WingLogDb
  let invoke: ReturnType<typeof fakeIpc>['invoke']
  const setAutoFinish = vi.fn()

  beforeEach(() => {
    db = createDb(':memory:').db
    migrate(db, { migrationsFolder: 'drizzle' })
    setAutoFinish.mockClear()
    setMainLanguage.mockClear()
    const ipc = fakeIpc()
    invoke = ipc.invoke
    registerSettingsHandlers(ipc.ipcMain, { db, trackingController: { setAutoFinish } })
  })

  it('reads back each unit and preference it stores', () => {
    expect(invoke(IpcChannels.settingsGetSimbriefUsername)).toBeNull()
    invoke(IpcChannels.settingsSetSimbriefUsername, 'pilot123')
    expect(invoke(IpcChannels.settingsGetSimbriefUsername)).toBe('pilot123')
    const pairs: [string, string, unknown][] = [
      [IpcChannels.settingsGetWeightUnit, IpcChannels.settingsSetWeightUnit, 'lb'],
      [IpcChannels.settingsGetAltitudeUnit, IpcChannels.settingsSetAltitudeUnit, 'm'],
      [IpcChannels.settingsGetMapLanguage, IpcChannels.settingsSetMapLanguage, 'fr'],
      [IpcChannels.settingsGetWindSpeedUnit, IpcChannels.settingsSetWindSpeedUnit, 'mps'],
      [IpcChannels.settingsGetLandingDistanceUnit, IpcChannels.settingsSetLandingDistanceUnit, 'm'],
      [IpcChannels.settingsGetTheme, IpcChannels.settingsSetTheme, 'dark']
    ]
    for (const [get, set, value] of pairs) {
      invoke(set, value)
      expect(invoke(get), get).toBe(value)
    }
    invoke(IpcChannels.settingsSetGsx, { enabled: true, folderPath: 'C:\\GSX', displayCurrency: 'GBP' })
    expect(invoke(IpcChannels.settingsGetGsx)).toEqual({
      enabled: true,
      folderPath: 'C:\\GSX',
      displayCurrency: 'GBP'
    })
  })

  it('switches the main-process language with the OS locale, and reports that locale', () => {
    invoke(IpcChannels.settingsSetAppLanguage, 'system')
    expect(invoke(IpcChannels.settingsGetAppLanguage)).toBe('system')
    expect(setMainLanguage).toHaveBeenCalledWith('system', 'de-DE')
    expect(invoke(IpcChannels.settingsGetSystemLocale)).toBe('de-DE')
  })

  it('stores the tracking settings and hands auto-finish to the live controller', () => {
    expect(invoke(IpcChannels.settingsGetTracking)).toEqual({ autoStart: true, autoFinish: true })
    invoke(IpcChannels.settingsSetTracking, { autoStart: true, autoFinish: false })
    expect(invoke(IpcChannels.settingsGetTracking)).toEqual({ autoStart: true, autoFinish: false })
    expect(setAutoFinish).toHaveBeenCalledWith(false)
  })

  it('rejects malformed tracking and update settings from the renderer', () => {
    expect(() => invoke(IpcChannels.settingsSetTracking, { autoStart: 'yes', autoFinish: true })).toThrow(
      'Invalid tracking settings'
    )
    expect(() => invoke(IpcChannels.settingsSetTracking, null)).toThrow('Invalid tracking settings')
    expect(() => invoke(IpcChannels.settingsSetUpdates, { checkEnabled: 1 })).toThrow(
      'Invalid update settings'
    )
    expect(() => invoke(IpcChannels.settingsSetUpdates, null)).toThrow('Invalid update settings')
    expect(setAutoFinish).not.toHaveBeenCalled()
    expect(invoke(IpcChannels.settingsGetUpdates)).toEqual({ checkEnabled: true })
    invoke(IpcChannels.settingsSetUpdates, { checkEnabled: false })
    expect(invoke(IpcChannels.settingsGetUpdates)).toEqual({ checkEnabled: false })
  })

  it('looks for GSX only on the first launch', () => {
    expect(invoke(IpcChannels.settingsCheckGsxFirstLaunch)).toEqual({ found: expect.any(Boolean) })
    expect(invoke(IpcChannels.settingsCheckGsxFirstLaunch)).toBeNull()
  })

  it('shows setup on a fresh install until it completes, and skips it with existing data', async () => {
    expect(invoke(IpcChannels.setupGetState)).toEqual({ show: true, whatsNew: false })
    invoke(IpcChannels.setupComplete)
    expect(invoke(IpcChannels.setupGetState)).toEqual({ show: false, whatsNew: false })

    const upgraded = createDb(':memory:').db
    migrate(upgraded, { migrationsFolder: 'drizzle' })
    createAircraft(upgraded, { registration: 'G-EUPT', icaoType: 'A319' })
    const ipc = fakeIpc()
    registerSettingsHandlers(ipc.ipcMain, { db: upgraded, trackingController: { setAutoFinish } })
    expect(ipc.invoke(IpcChannels.setupGetState)).toEqual({ show: false, whatsNew: true })

    getSetupContext.mockResolvedValueOnce({ simConnected: false })
    expect(await invoke(IpcChannels.setupGetContext)).toEqual({ simConnected: false })
  })
})
