import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { SimConnectionStatus } from '@shared/ipc'
import { createAircraft } from '../db/aircraft-repo'
import { createDb } from '../db/client'
import { createFlight } from '../db/flight-repo'
import type { TrackingController } from '../tracking/TrackingController'
import { shownFlightOf, wireFlightNavdata } from './wire-flight-navdata'

function freshDb() {
  const { db } = createDb(':memory:')
  migrate(db, { migrationsFolder: 'drizzle' })
  return db
}

/** A sim whose status the test sets, announcing each change as the real one does. */
class FakeSim extends EventEmitter {
  status: SimConnectionStatus = { state: 'disconnected' }
  getStatus(): SimConnectionStatus {
    return this.status
  }
  set(status: SimConnectionStatus): void {
    this.status = status
    this.emit('status', status)
  }
}

/** A tracking controller with the two members the wiring uses: its events and the flight being tracked. */
function tracking(activeFlightId?: number): EventEmitter & Pick<TrackingController, 'getActive'> {
  return Object.assign(new EventEmitter(), {
    getActive: () => (activeFlightId === undefined ? undefined : { flightId: activeFlightId })
  }) as unknown as EventEmitter & Pick<TrackingController, 'getActive'>
}

describe('shownFlightOf', () => {
  it('is the newest planned flight, or the tracked one, with its airports and plan', () => {
    const db = freshDb()
    const aircraftId = createAircraft(db, { registration: '9V-SKA', icaoType: 'A388' }).id
    const first = createFlight(db, { aircraftId, depIcao: 'WSSS', arrIcao: 'EGLL' })
    const second = createFlight(db, { aircraftId, depIcao: 'ZJSY', arrIcao: 'VHHH' })
    expect(shownFlightOf(db, undefined)).toMatchObject({
      flightId: second.id,
      depIcao: 'ZJSY',
      arrIcao: 'VHHH'
    })
    expect(shownFlightOf(db, first.id)).toMatchObject({ flightId: first.id, depIcao: 'WSSS' })
  })

  it('is undefined with nothing planned or tracked', () => {
    expect(shownFlightOf(freshDb(), undefined)).toBeUndefined()
  })
})

describe('wireFlightNavdata', () => {
  function setup() {
    const db = freshDb()
    const aircraftId = createAircraft(db, { registration: '9V-SKA', icaoType: 'A388' }).id
    const sim = new FakeSim()
    const calls: string[] = []
    const provider = {
      refreshAirport: vi.fn((icao: string) => {
        calls.push(`airport ${icao}`)
        return Promise.resolve()
      }),
      refreshTaxiNetwork: vi.fn((icao: string) => {
        calls.push(`taxi ${icao}`)
        return Promise.resolve()
      })
    }
    return { db, aircraftId, sim, calls, provider }
  }

  it('fetches when the sim connects for a flight that was already planned', async () => {
    const { db, aircraftId, sim, calls, provider } = setup()
    createFlight(db, { aircraftId, depIcao: 'ZJSY', arrIcao: 'VHHH' })
    const fetcher = wireFlightNavdata({ db, sim, trackingController: tracking() as never, provider })
    await fetcher.idle()
    expect(calls).toEqual([])
    sim.set({ state: 'connected', simConnectVersion: '12.2' })
    await fetcher.idle()
    expect(calls).toEqual(['airport VHHH', 'airport ZJSY', 'taxi VHHH', 'taxi ZJSY'])
  })

  it('does not fetch when the sim goes down or is connecting', async () => {
    const { db, aircraftId, sim, calls, provider } = setup()
    createFlight(db, { aircraftId, depIcao: 'ZJSY', arrIcao: 'VHHH' })
    const fetcher = wireFlightNavdata({ db, sim, trackingController: tracking() as never, provider })
    sim.set({ state: 'connecting' })
    sim.set({ state: 'disconnected' })
    await fetcher.idle()
    expect(calls).toEqual([])
  })

  it('fetches when a flight starts being tracked, with the sim already connected', async () => {
    const { db, aircraftId, sim, calls, provider } = setup()
    sim.status = { state: 'connected', simConnectVersion: '12.2' }
    const controller = tracking()
    const fetcher = wireFlightNavdata({ db, sim, trackingController: controller as never, provider })
    await fetcher.idle()
    expect(calls).toEqual([])
    createFlight(db, { aircraftId, depIcao: 'EGLL', arrIcao: 'WMKK' })
    controller.emit('started')
    await fetcher.idle()
    expect(calls).toContain('airport WMKK')
    expect(calls).toContain('taxi EGLL')
  })

  it('fetches at start-up for a flight planned before the app was last closed, if the sim is up', async () => {
    const { db, aircraftId, sim, calls, provider } = setup()
    sim.status = { state: 'connected', simConnectVersion: '12.2' }
    createFlight(db, { aircraftId, depIcao: 'ZJSY', arrIcao: 'VHHH' })
    const fetcher = wireFlightNavdata({ db, sim, trackingController: tracking() as never, provider })
    await fetcher.idle()
    expect(calls).toHaveLength(4)
  })
})
