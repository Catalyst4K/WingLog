import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createDb, type WingLogDb } from '../db/client'
import { createAircraft } from '../db/aircraft-repo'
import { createFlight, getFlightUuidById } from '../db/flight-repo'
import { FlightRelay } from './flight-relay'

/** The refusal's English wording, as a user sees it: the link is down or reconnecting, so try again. */
const NOT_CONNECTED =
  "The sim PC isn't connected right now (the link may be reconnecting). Try again in a moment."

/** The refusal when the link is up but the two WingLogs could not be brought level. */
const SYNC_FAILED =
  "Couldn't bring this computer up to date with the sim PC. Try again, or check Settings → Devices."

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

  /** @param syncOk Whether the sync ends well. @param connected Whether the link is up before the sync; `linkAfterSync` is whether it is after. */
  function bound(
    syncOk = true,
    connected = true,
    linkAfterSync = connected,
    refusal = NOT_CONNECTED
  ): FlightRelay {
    let up = connected
    const relay = new FlightRelay(db)
    relay.bind(
      {
        run: () => {
          calls.push('sync')
          up = linkAfterSync
          return Promise.resolve(syncOk)
        },
        connected: () => up,
        refusal: () => (up ? '' : refusal)
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

  it('refuses Cancel and Start with the reconnecting message while the link is down, without trying to sync', async () => {
    await expect(bound(false, false).cancel(flightId)).rejects.toThrow(NOT_CONNECTED)
    await expect(bound(false, false).start(flightId)).rejects.toThrow(NOT_CONNECTED)
    expect(calls).toEqual([])
  })

  it('says the link may be reconnecting when it drops during the sync', async () => {
    await expect(bound(false, true, false).start(flightId)).rejects.toThrow(NOT_CONNECTED)
    expect(calls).toEqual(['sync'])
  })

  it('tells the pilot what the link says, so after Forget every button says to pair', async () => {
    const NOT_PAIRED = "This computer isn't paired with a sim PC. Pair it in Settings → Devices."
    await expect(bound(false, false, false, NOT_PAIRED).cancel(flightId)).rejects.toThrow(NOT_PAIRED)
    await expect(bound(false, true, false, NOT_PAIRED).start(flightId)).rejects.toThrow(NOT_PAIRED)
  })

  it('says the sync failed, not that the link is reconnecting, when the link is up when the sync ends badly (also if it dropped and came back during it)', async () => {
    await expect(bound(false, true, true).cancel(flightId)).rejects.toThrow(SYNC_FAILED)
    expect(calls).toEqual(['sync'])
  })

  it('has the sim PC set an airport of the free flight it tracks, then brings this computer level so the screen reads it back', async () => {
    const relay = bound()
    await relay.setDestination(flightId, 'EGCC')
    await relay.setDeparture(flightId, null)
    expect(calls).toEqual([
      `flight.setDestination:${uuid},EGCC`,
      'sync',
      `flight.setDeparture:${uuid},`,
      'sync'
    ])
  })

  it('does not sync after an airport the sim PC refused, and passes the refusal on', async () => {
    const run = vi.fn(() => Promise.resolve(true))
    const relay = new FlightRelay(db)
    relay.bind({ run, connected: () => true, refusal: () => '' }, () =>
      Promise.reject(new Error('Not a valid airport code'))
    )
    await expect(relay.setDestination(flightId, 'x!')).rejects.toThrow('Not a valid airport code')
    await expect(relay.setDeparture(9999, 'EGLL')).rejects.toThrow('Unknown flight')
    expect(run).not.toHaveBeenCalled()
  })

  it('refuses a flight it does not know, and everything before it is bound to a link', async () => {
    await expect(bound().fly(9999)).rejects.toThrow('Unknown flight')
    const unbound = new FlightRelay(db)
    await expect(unbound.fly(flightId)).rejects.toThrow(NOT_CONNECTED)
    await expect(unbound.finish()).rejects.toThrow(NOT_CONNECTED)
    expect(vi.isMockFunction(unbound.stop)).toBe(false)
  })
})
