import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createDb, type WingLogDb } from '../db/client'
import { createAircraft } from '../db/aircraft-repo'
import { createFlight, getFlightUuidById } from '../db/flight-repo'
import { FlightRelay } from './flight-relay'

describe('FlightRelay', () => {
  let db: WingLogDb
  let flightId: number
  let uuid: string
  const calls: string[] = []

  beforeEach(() => {
    db = createDb(':memory:').db
    migrate(db, { migrationsFolder: 'drizzle' })
    const aircraftId = createAircraft(db, { registration: 'G-TEST', icaoType: 'A320' }).id
    flightId = createFlight(db, { aircraftId, depIcao: 'EGLL', arrIcao: 'EGCC', status: 'planned' }).id
    uuid = getFlightUuidById(db, flightId) as string
    calls.length = 0
  })

  function bound(syncOk = true): FlightRelay {
    const relay = new FlightRelay(db)
    relay.bind(
      {
        run: () => {
          calls.push('sync')
          return Promise.resolve(syncOk)
        }
      },
      (name, ...args) => {
        calls.push(`${name}:${args.join(',')}`)
        return Promise.resolve(undefined)
      }
    )
    return relay
  }

  it('brings the sim PC level, then names the flight to it by uuid', async () => {
    const relay = bound()
    await relay.fly(flightId)
    await relay.start(flightId)
    await relay.cancel(flightId)
    expect(calls).toEqual([
      'sync',
      `flight.fly:${uuid}`,
      'sync',
      `flight.start:${uuid}`,
      'sync',
      `flight.cancel:${uuid}`
    ])
  })

  it('finishes and stops without naming a flight or syncing first', async () => {
    const relay = bound()
    await relay.finish()
    await relay.stop()
    expect(calls).toEqual(['flight.finish:', 'flight.stop:'])
  })

  it('says so when the sim PC could not be brought level, and sends nothing', async () => {
    await expect(bound(false).start(flightId)).rejects.toThrow('not connected')
    expect(calls).toEqual(['sync'])
  })

  it('refuses a flight it does not know, and everything before it is bound to a link', async () => {
    await expect(bound().fly(9999)).rejects.toThrow('Unknown flight')
    const unbound = new FlightRelay(db)
    await expect(unbound.fly(flightId)).rejects.toThrow('Not connected to the sim PC')
    await expect(unbound.finish()).rejects.toThrow('Not connected to the sim PC')
    expect(vi.isMockFunction(unbound.stop)).toBe(false)
  })
})
