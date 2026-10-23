import { describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { IpcChannels } from '@shared/ipc'
import type { TaxiRoute } from '@shared/live'
import { createAircraft } from '../db/aircraft-repo'
import { createDb } from '../db/client'
import { createFlight } from '../db/flight-repo'
import { fakeIpc } from '../ipc/fake-ipc'
import { LiveHub } from '../live/LiveHub'
import { startTaxiRoute } from './start-taxi-route'

vi.mock('../logging/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }))

function setup() {
  const { db } = createDb(':memory:')
  migrate(db, { migrationsFolder: 'drizzle' })
  const aircraftId = createAircraft(db, { registration: '9V-SKA', icaoType: 'A388' }).id
  createFlight(db, { aircraftId, depIcao: 'ZJSY', arrIcao: 'VHHH' })
  const hub = new LiveHub()
  const ipc = fakeIpc()
  const stop = startTaxiRoute(ipc.ipcMain, {
    db,
    liveHub: hub,
    trackingController: { getActive: () => undefined },
    navdata: {
      getTaxiNetwork: () => [],
      listRunways: () => [],
      getStands: () => Promise.resolve([]),
      onAirportRefreshed: () => () => undefined
    }
  })
  return { hub, ipc, stop }
}

describe('startTaxiRoute', () => {
  it('answers a window that asks for the line: nothing at first, then the one the hub holds', async () => {
    const { hub, ipc } = setup()
    expect(await ipc.invoke(IpcChannels.taxiRouteGet)).toBeNull()
    const route: TaxiRoute = {
      flightId: 1,
      icao: 'ZJSY',
      revision: 7,
      kind: 'exact',
      line: [[109.4, 18.3]],
      clearance: { taxiways: ['D'], holdingPoint: 'A', stand: null, holdShortRunway: null }
    }
    hub.publish('taxiRoute', route)
    expect(await ipc.invoke(IpcChannels.taxiRouteGet)).toEqual(route)
  })

  it('follows the hub until stopped, for the flight the database says is shown', () => {
    const { hub, stop } = setup()
    const seen: unknown[] = []
    hub.subscribe((topic, payload) => {
      if (topic === 'taxiRoute') seen.push(payload)
    })
    // A clearance with no network cached still publishes (the clearance, no line): the service is running and found the planned flight.
    hub.publish('simTelemetry', {
      latitude: 18.3,
      longitude: 109.4,
      headingTrueDeg: 90,
      groundSpeedMs: 1
    } as never)
    hub.publish('beyondAtcState', {
      infoBoxes: [{ title: 'Taxi Via 1', info: 'D' }],
      facility: null
    } as never)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ flightId: 1, kind: null })
    stop()
    hub.publish('beyondAtcState', {
      infoBoxes: [{ title: 'Taxi Via 1', info: 'B' }],
      facility: null
    } as never)
    expect(seen).toHaveLength(1)
  })
})
