import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { BrowserWindow } from 'electron'
import { IpcChannels, type Aircraft } from '@shared/ipc'
import { createDb, type WingLogDb } from '../db/client'
import { completeFlight, createFlight, startFlight } from '../db/flight-repo'
import { registerFleetHandlers } from './fleet-handlers'
import { fakeIpc } from './fake-ipc'

const importAircraft = vi.fn()
const exportAircraft = vi.fn()
vi.mock('../db/aircraft-import-export', () => ({
  importAircraft: (...args: unknown[]) => importAircraft(...args),
  exportAircraft: (...args: unknown[]) => exportAircraft(...args)
}))

describe('fleet IPC handlers', () => {
  let db: WingLogDb
  let invoke: ReturnType<typeof fakeIpc>['invoke']
  const sync = vi.fn()
  const window = {} as BrowserWindow

  beforeEach(() => {
    db = createDb(':memory:').db
    migrate(db, { migrationsFolder: 'drizzle' })
    sync.mockClear()
    importAircraft.mockReset()
    exportAircraft.mockReset()
    const ipc = fakeIpc()
    invoke = ipc.invoke
    registerFleetHandlers(ipc.ipcMain, { db, window, scheduleBackgroundSync: sync })
  })

  it('creates, updates and lists aircraft, syncing after each change', () => {
    const created = invoke(IpcChannels.aircraftCreate, {
      registration: ' G-EUPT ',
      icaoType: 'A319'
    }) as Aircraft
    expect(created.registration).toBe('G-EUPT')
    const updated = invoke(IpcChannels.aircraftUpdate, {
      id: created.id,
      registration: 'G-EUPT',
      icaoType: 'A320'
    }) as Aircraft
    expect(updated.icaoType).toBe('A320')
    expect((invoke(IpcChannels.aircraftList) as Aircraft[]).map((a) => a.icaoType)).toEqual(['A320'])
    expect(sync).toHaveBeenCalledTimes(2)
  })

  it('rejects invalid input from the renderer', () => {
    expect(() => invoke(IpcChannels.aircraftCreate, { registration: '  ', icaoType: 'A320' })).toThrow(
      '"registration" is required'
    )
    expect(() =>
      invoke(IpcChannels.aircraftUpdate, { id: 999, registration: 'G-EUPT', icaoType: 'A320' })
    ).toThrow('Aircraft 999 not found')
    expect(() => invoke(IpcChannels.aircraftRetire, '1')).toThrow()
    expect(() => invoke(IpcChannels.aircraftUnretire, 1.5)).toThrow()
    expect(sync).not.toHaveBeenCalled()
  })

  it('retires, replaces, unretires and deletes', () => {
    const old = invoke(IpcChannels.aircraftCreate, { registration: 'G-EUPA', icaoType: 'A319' }) as Aircraft
    const replacement = invoke(IpcChannels.aircraftCreate, {
      registration: 'G-EUPB',
      icaoType: 'A319'
    }) as Aircraft
    invoke(IpcChannels.aircraftRetire, old.id)
    invoke(IpcChannels.aircraftUnretire, old.id)
    invoke(IpcChannels.aircraftReplace, old.id, replacement.id)
    invoke(IpcChannels.aircraftDelete, replacement.id)
    expect(sync).toHaveBeenCalledTimes(6)
  })

  it('imports (syncing only when something came in) and exports in the format asked for', async () => {
    importAircraft.mockResolvedValueOnce(null).mockResolvedValueOnce({ added: 2 })
    expect(await invoke(IpcChannels.aircraftImport, 'csv')).toBeNull()
    expect(sync).not.toHaveBeenCalled()
    expect(await invoke(IpcChannels.aircraftImport, 'anything')).toEqual({ added: 2 })
    expect(importAircraft).toHaveBeenLastCalledWith(db, window, 'json')
    expect(sync).toHaveBeenCalledTimes(1)
    invoke(IpcChannels.aircraftExport, 'csv')
    expect(exportAircraft).toHaveBeenCalledWith(db, window, 'csv')
  })

  it("lists an aircraft's flights, landings and last stands", () => {
    const aircraft = invoke(IpcChannels.aircraftCreate, {
      registration: 'B-HSL',
      icaoType: 'A320'
    }) as Aircraft
    const flight = createFlight(db, { aircraftId: aircraft.id, depIcao: 'VHHH', arrIcao: 'ZJSY' })
    startFlight(db, flight.id, 6000)
    completeFlight(db, flight.id, 3000)
    expect((invoke(IpcChannels.fleetListFlights, aircraft.id) as { id: number }[]).map((f) => f.id)).toEqual([
      flight.id
    ])
    expect(invoke(IpcChannels.fleetListLandings, aircraft.id)).toEqual([])
    expect(invoke(IpcChannels.fleetListLastParked)).toEqual([])
  })
})
