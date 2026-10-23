import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { IpcChannels, type ProcedureSelection } from '@shared/ipc'
import { emptyProcedureSelection } from '@shared/procedure-selection'
import { createAircraft } from '../db/aircraft-repo'
import { createDb } from '../db/client'
import { abandonAllPlanned, createFlight, getFlight } from '../db/flight-repo'
import { fakeIpc } from '../ipc/fake-ipc'
import { LiveHub } from '../live/LiveHub'
import { startProcedureSelection } from './start-procedure-selection'

vi.mock('../logging/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }))

function setup() {
  const { db } = createDb(':memory:')
  migrate(db, { migrationsFolder: 'drizzle' })
  const aircraftId = createAircraft(db, { registration: '9V-SKA', icaoType: 'A388' }).id
  const flight = createFlight(db, {
    aircraftId,
    depIcao: 'ZGGG',
    arrIcao: 'ZJSY',
    selectedSidIdent: 'SAVED1A'
  })
  const hub = new LiveHub()
  const published: (ProcedureSelection | null)[] = []
  hub.subscribe((topic, payload) => {
    if (topic === 'procedureSelection') published.push(payload as ProcedureSelection | null)
  })
  const ipc = fakeIpc()
  const tracking = Object.assign(new EventEmitter(), {
    getActive: () => undefined as { flightId: number } | undefined
  })
  const store = startProcedureSelection(ipc.ipcMain, {
    db,
    liveHub: hub,
    trackingController: tracking as never,
    navdata: {
      listApproaches: () => [],
      getProcedureWaypoints: () => [],
      onAirportRefreshed: () => () => undefined
    }
  })
  return { db, aircraftId, flight, hub, published, ipc, tracking, store }
}

describe('startProcedureSelection', () => {
  it("is already holding the flight shown's saved choice, announced and answerable by a window that asks", async () => {
    const { published, ipc } = setup()
    expect(published.at(-1)).toMatchObject({ sidIdent: 'SAVED1A' })
    expect(await ipc.invoke(IpcChannels.trackingGetProcedureSelection)).toMatchObject({ sidIdent: 'SAVED1A' })
  })

  it("takes a window's choice: saved on the flight, announced to every screen, and what a window later asks for", async () => {
    const { db, flight, published, ipc } = setup()
    const choice = { ...emptyProcedureSelection(), sidIdent: 'BPK7F', starIdent: 'UPRS2C' }
    await ipc.invoke(IpcChannels.trackingSetProcedureSelection, choice)
    expect(getFlight(db, flight.id)).toMatchObject({ selectedSidIdent: 'BPK7F', selectedStarIdent: 'UPRS2C' })
    expect(published.at(-1)).toEqual(choice)
    expect(await ipc.invoke(IpcChannels.trackingGetProcedureSelection)).toEqual(choice)
  })

  it('refuses a choice that is not a short-text selection, as it would from a phone', () => {
    const { ipc, store } = setup()
    expect(() => ipc.invoke(IpcChannels.trackingSetProcedureSelection, { sidIdent: 7 })).toThrow()
    expect(() => ipc.invoke(IpcChannels.trackingSetProcedureSelection, 'BPK7F')).toThrow()
    expect(store.current()).toMatchObject({ sidIdent: 'SAVED1A' })
  })

  it('looks again at the flight shown when tracking starts, stops or completes: nothing is held once none is shown', async () => {
    const { db, flight, published, ipc, tracking } = setup()
    abandonAllPlanned(db)
    tracking.emit('stopped', flight.id)
    expect(published.at(-1)).toBeNull()
    expect(await ipc.invoke(IpcChannels.trackingGetProcedureSelection)).toBeNull()
  })

  it('answers null before any flight exists', async () => {
    const { db, aircraftId, ipc, store, tracking, flight } = setup()
    abandonAllPlanned(db)
    tracking.emit('completed', flight.id)
    expect(store.current()).toBeUndefined()
    createFlight(db, { aircraftId, depIcao: 'EGLL', arrIcao: 'EGCC', selectedSidIdent: 'NEXT' })
    tracking.emit('started', 2)
    expect(await ipc.invoke(IpcChannels.trackingGetProcedureSelection)).toMatchObject({ sidIdent: 'NEXT' })
  })
})
