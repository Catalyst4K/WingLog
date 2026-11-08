import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createDb, type WingLogDb } from '../db/client'
import { createAircraft } from '../db/aircraft-repo'
import { createFlight, getFlightUuidById, getLiveFlight } from '../db/flight-repo'
import { flightControl, twinFlightQueries } from './twin-flight'

describe('what a twin may make the sim PC do with a flight', () => {
  let db: WingLogDb
  let aircraftId: number
  const tracking = { start: vi.fn(), stop: vi.fn(), finish: vi.fn() }
  const autoStart = { arm: vi.fn(), disarm: vi.fn() }
  const releaseReplay = vi.fn()
  const flightsChanged = vi.fn()

  beforeEach(() => {
    db = createDb(':memory:').db
    migrate(db, { migrationsFolder: 'drizzle' })
    aircraftId = createAircraft(db, { registration: 'G-TEST', icaoType: 'A320' }).id
    vi.clearAllMocks()
  })

  function control() {
    return flightControl({
      db,
      trackingController: tracking,
      autoStartDetector: autoStart,
      getLastTelemetry: () => undefined,
      releaseReplay,
      onFlightsChanged: flightsChanged
    })
  }

  const planned = (dep = 'EGLL', arr = 'EGCC') => {
    const flight = createFlight(db, { aircraftId, depIcao: dep, arrIcao: arr, status: 'planned' })
    return { id: flight.id, uuid: getFlightUuidById(db, flight.id) as string }
  }

  it('flies a planned flight: stops what was tracked, removes any other planned one, as Fly does here, and arms auto-start for it', () => {
    const older = planned('EGKK', 'EGLL')
    const flight = planned()
    control().fly(flight.uuid)
    expect(tracking.stop).toHaveBeenCalled()
    expect(getLiveFlight(db, older.id)).toBeUndefined()
    expect(getLiveFlight(db, flight.id)?.status).toBe('planned')
    expect(autoStart.arm).toHaveBeenCalledWith(flight.id, undefined, 'EGLL')
    expect(flightsChanged).toHaveBeenCalled()
  })

  it('starts tracking a planned flight now, and lets a held replay play', () => {
    const flight = planned()
    control().start(flight.uuid)
    expect(autoStart.disarm).toHaveBeenCalled()
    expect(tracking.start).toHaveBeenCalledWith(flight.id)
    expect(releaseReplay).toHaveBeenCalled()
  })

  it('refuses a flight it does not have, or that is not planned, and does nothing', () => {
    expect(() => control().fly('no-such-uuid')).toThrow('has not reached this computer')
    expect(() => control().start('no-such-uuid')).toThrow('has not reached this computer')
    const flight = createFlight(db, { aircraftId, depIcao: 'EGLL', arrIcao: 'EGCC', status: 'active' })
    expect(() => control().start(getFlightUuidById(db, flight.id) as string)).toThrow('not planned')
    expect(tracking.start).not.toHaveBeenCalled()
    expect(autoStart.arm).not.toHaveBeenCalled()
  })

  it('finishes and stops what is being tracked', () => {
    control().finish()
    control().stop()
    expect(tracking.finish).toHaveBeenCalled()
    expect(tracking.stop).toHaveBeenCalled()
  })

  it('cancels a planned flight (it is removed, as here) and disarms auto-start, and is quiet about one it does not have', () => {
    const flight = planned()
    control().cancel(flight.uuid)
    expect(getLiveFlight(db, flight.id)).toBeUndefined()
    expect(autoStart.disarm).toHaveBeenCalled()
    expect(() => control().cancel('unknown')).not.toThrow()
  })

  it('exposes them as lookups that check their argument', () => {
    const queries = twinFlightQueries({
      fly: vi.fn(),
      start: vi.fn(),
      finish: vi.fn(),
      stop: vi.fn(),
      cancel: vi.fn()
    })
    expect(Object.keys(queries).sort()).toEqual([
      'flight.cancel',
      'flight.finish',
      'flight.fly',
      'flight.start',
      'flight.stop'
    ])
    for (const bad of [undefined, 5, '', 'x'.repeat(65), {}]) {
      expect(() => queries['flight.fly'](bad)).toThrow('Invalid flight')
      expect(() => queries['flight.start'](bad)).toThrow('Invalid flight')
      expect(() => queries['flight.cancel'](bad)).toThrow('Invalid flight')
    }
    expect(() => queries['flight.finish']()).not.toThrow()
  })
})
