import { describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { IpcChannels } from '@shared/ipc'
import { createAircraft } from '../db/aircraft-repo'
import { createDb } from '../db/client'
import { createFlight } from '../db/flight-repo'
import { fakeIpc } from '../ipc/fake-ipc'
import { registerClientLocalHandlers } from './client-local-handlers'

function setup() {
  const { db } = createDb(':memory:')
  migrate(db, { migrationsFolder: 'drizzle' })
  const ipc = fakeIpc()
  const openExternal = vi.fn(() => Promise.resolve())
  registerClientLocalHandlers(ipc.ipcMain, { db, openExternal })
  return { db, ipc, openExternal }
}

describe('what a client answers from its own computer', () => {
  it('registers filing on VATSIM and IVAO, and the GSX routines', () => {
    const { ipc } = setup()
    for (const channel of [
      IpcChannels.onlinePrefileFromOfp,
      IpcChannels.onlinePrefileForFlight,
      IpcChannels.gsxRoutinesList,
      IpcChannels.gsxRoutinesSave,
      IpcChannels.gsxRoutinesDelete
    ])
      expect(ipc.has(channel), channel).toBe(true)
  })

  it('opens the filing page from its own copy of the flight’s OFP in its own browser, and nothing else', async () => {
    const { db, ipc, openExternal } = setup()
    const link = 'https://my.vatsim.net/pilots/flightplan?departure=EGLL&arrival=EGCC'
    const aircraftId = createAircraft(db, { registration: 'G-MACF', icaoType: 'A320' }).id
    const flight = createFlight(db, {
      aircraftId,
      depIcao: 'EGLL',
      arrIcao: 'EGCC',
      ofpJson: JSON.stringify({ prefile: { vatsim: { link } } })
    })
    expect(await ipc.invoke(IpcChannels.onlinePrefileForFlight, flight.id, 'vatsim')).toBe(true)
    expect(openExternal).toHaveBeenCalledWith(link)
    // A link that is not the network's own page is never opened.
    const other = createFlight(db, {
      aircraftId,
      depIcao: 'EGLL',
      arrIcao: 'EGCC',
      ofpJson: JSON.stringify({ prefile: { vatsim: { link: 'https://evil.example/pilots/flightplan' } } })
    })
    expect(await ipc.invoke(IpcChannels.onlinePrefileForFlight, other.id, 'vatsim')).toBe(false)
    expect(openExternal).toHaveBeenCalledTimes(1)
  })
})
