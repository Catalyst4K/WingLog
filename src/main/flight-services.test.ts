import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { IpcChannels } from '@shared/ipc'
import { createDb } from './db/client'
import { startFlightServices } from './flight-services'
import { fakeIpc } from './ipc/fake-ipc'
import { LiveHub } from './live/LiveHub'

vi.mock('./logging/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }))

function start(isClient: boolean) {
  const { db } = createDb(':memory:')
  migrate(db, { migrationsFolder: 'drizzle' })
  const ipc = fakeIpc()
  const hub = new LiveHub()
  const taxiRoutes: unknown[] = []
  hub.subscribe((topic, payload) => {
    if (topic === 'taxiRoute') taxiRoutes.push(payload)
  })
  const services = startFlightServices(ipc.ipcMain, {
    db,
    sim: Object.assign(new EventEmitter(), { getStatus: () => ({ state: 'disconnected' }) }) as never,
    liveHub: hub,
    trackingController: Object.assign(new EventEmitter(), { getActive: () => undefined }) as never,
    navdata: {
      getTaxiNetwork: () => [],
      listRunways: () => [],
      getStands: () => Promise.resolve([]),
      listApproaches: () => [],
      getProcedureWaypoints: () => [],
      onAirportRefreshed: () => () => undefined
    } as never,
    onWrite: vi.fn(),
    isClient
  })
  return { ipc, hub, taxiRoutes, services }
}

describe('startFlightServices', () => {
  it('traces the taxi line on the sim PC', () => {
    const { ipc, services } = start(false)
    expect(ipc.has(IpcChannels.taxiRouteGet)).toBe(true)
    expect(() => services.stop()).not.toThrow()
  })

  it('starts no taxi line service on a client, whose line is the sim PC’s and which would publish a "no line" over it', () => {
    const { ipc, hub, taxiRoutes, services } = start(true)
    expect(ipc.has(IpcChannels.taxiRouteGet)).toBe(false)
    // The sim PC's line, held in this computer's hub, is not touched by anything here.
    const line = { kind: 'taxi', line: [[1, 2]] } as never
    hub.publish('taxiRoute', line)
    hub.publish('simTelemetry', { latitude: 1, longitude: 2 } as never)
    expect(taxiRoutes).toEqual([line])
    expect(() => services.stop()).not.toThrow()
  })

  it('still holds the procedure choice on a client', () => {
    const { ipc } = start(true)
    expect(ipc.has(IpcChannels.trackingGetProcedureSelection)).toBe(true)
  })
})
