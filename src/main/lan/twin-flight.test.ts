import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { ActiveTracking } from '@shared/ipc'
import { createDb, type WingLogDb } from '../db/client'
import { createAircraft } from '../db/aircraft-repo'
import { createFlight, getFlightUuidById, getLiveFlight } from '../db/flight-repo'
import { createTrackPoint, listTrackPoints } from '../db/track-point-repo'
import { flightControl, twinFlightQueries, type FlightControl } from './twin-flight'

/** One recorded point of a flight's track. */
function trackPoint(flightId: number, i: number): Record<string, unknown> {
  return {
    flightId,
    tsUtc: new Date(Date.UTC(2026, 10, 8, 12, 0, i)).toISOString(),
    latitude: 51 + i / 1000,
    longitude: -0.4,
    altitudeM: 100 + i,
    pressureAltitudeM: null,
    altitudeAglM: 0,
    indicatedAirspeedMs: 70,
    machSpeed: 0.2,
    groundSpeedMs: 70,
    verticalSpeedMs: 0,
    headingTrueDeg: 270,
    pitchDeg: 0,
    bankDeg: 0,
    phase: 'climb',
    onGround: false,
    fuelKg: 5000,
    gForce: 1,
    windSpeedMs: 0,
    windDirectionDeg: 0,
    resumeSegment: 0,
    simRate: 1,
    excludedReason: null
  }
}

/** A FlightControl that does nothing. */
function fakeControl(): FlightControl {
  return {
    fly: vi.fn(),
    start: vi.fn(),
    finish: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
    setDestination: vi.fn(),
    setDeparture: vi.fn()
  }
}

describe('what a twin may make the sim PC do with a flight', () => {
  let db: WingLogDb
  let aircraftId: number
  const tracking = {
    start: vi.fn(),
    stop: vi.fn(),
    finish: vi.fn(),
    getActive: vi.fn((): ActiveTracking | undefined => undefined),
    setDestination: vi.fn(),
    setDeparture: vi.fn()
  }
  const autoStart = { arm: vi.fn(), disarm: vi.fn() }
  const releaseReplay = vi.fn()
  const flightsChanged = vi.fn()
  const syncTold = vi.fn()

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
      onFlightsChanged: flightsChanged,
      scheduleBackgroundSync: syncTold
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
    // The other planned flight was removed here: a twin and the cloud must hear of it.
    expect(syncTold).toHaveBeenCalledTimes(1)
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

  it('cancels a planned flight (it is removed, as here) and disarms auto-start', () => {
    const flight = planned()
    control().cancel(flight.uuid)
    expect(getLiveFlight(db, flight.id)).toBeUndefined()
    expect(autoStart.disarm).toHaveBeenCalled()
    expect(flightsChanged).toHaveBeenCalled()
    expect(syncTold).toHaveBeenCalledTimes(1)
  })

  it('refuses to cancel a flight it does not have, and does nothing (audit M9)', () => {
    expect(() => control().cancel('unknown')).toThrow('has not reached this computer')
    expect(autoStart.disarm).not.toHaveBeenCalled()
    expect(flightsChanged).not.toHaveBeenCalled()
    expect(syncTold).not.toHaveBeenCalled()
  })

  it.each(['active', 'completed'] as const)(
    'refuses to cancel a flight that is %s, and leaves it and its track points as they were (audit M9)',
    (status) => {
      const flight = createFlight(db, { aircraftId, depIcao: 'EGLL', arrIcao: 'EGCC', status })
      const uuid = getFlightUuidById(db, flight.id) as string
      for (let i = 0; i < 3; i++) createTrackPoint(db, trackPoint(flight.id, i) as never)
      expect(() => control().cancel(uuid)).toThrow('not planned')
      expect(getLiveFlight(db, flight.id)?.status).toBe(status)
      expect(listTrackPoints(db, flight.id)).toHaveLength(3)
      expect(autoStart.disarm).not.toHaveBeenCalled()
      expect(flightsChanged).not.toHaveBeenCalled()
    }
  )

  describe('the airports of a free flight', () => {
    const free = (): { id: number; uuid: string } => {
      const flight = createFlight(db, { aircraftId, depIcao: 'ZZZZ', arrIcao: 'ZZZZ', status: 'active' })
      tracking.getActive.mockReturnValue({ flightId: flight.id, phase: 'cruise' })
      return { id: flight.id, uuid: getFlightUuidById(db, flight.id) as string }
    }

    it('sets the destination and the departure of the flight being tracked, when the twin names that flight', () => {
      const flight = free()
      control().setDestination(flight.uuid, 'EGCC')
      control().setDeparture(flight.uuid, null)
      expect(tracking.setDestination).toHaveBeenCalledWith('EGCC')
      expect(tracking.setDeparture).toHaveBeenCalledWith(null)
    })

    it('refuses when the twin names another flight or none is tracked, and changes nothing', () => {
      const flight = free()
      const other = planned()
      expect(() => control().setDestination(other.uuid, 'EGCC')).toThrow('not the one being tracked')
      expect(() => control().setDeparture('no-such-uuid', 'EGLL')).toThrow('not the one being tracked')
      tracking.getActive.mockReturnValue(undefined)
      expect(() => control().setDestination(flight.uuid, 'EGCC')).toThrow('not the one being tracked')
      expect(tracking.setDestination).not.toHaveBeenCalled()
      expect(tracking.setDeparture).not.toHaveBeenCalled()
    })

    it('lets the tracking controller judge the code, so a bad code is refused as it is on the sim PC', () => {
      const flight = free()
      tracking.setDestination.mockImplementationOnce(() => {
        throw new Error('Not a valid airport code')
      })
      expect(() => control().setDestination(flight.uuid, 'not a code!')).toThrow('Not a valid airport code')
    })

    it('checks what a twin sends before it gets that far', () => {
      const changed = vi.fn()
      const control = fakeControl()
      const queries = twinFlightQueries(control, changed)
      for (const name of ['flight.setDestination', 'flight.setDeparture']) {
        expect(() => queries[name]('', 'EGCC'), name).toThrow('Invalid flight')
        expect(() => queries[name]('u', 5), name).toThrow('Invalid airport')
        expect(() => queries[name]('u', 'EGCCEGCCEGCC'), name).toThrow('Invalid airport')
        expect(() => queries[name]('u', undefined), name).toThrow('Invalid airport')
      }
      queries['flight.setDestination']('u', 'EGCC')
      queries['flight.setDeparture']('u', null)
      expect(control.setDestination).toHaveBeenCalledWith('u', 'EGCC')
      expect(control.setDeparture).toHaveBeenCalledWith('u', null)
      expect(changed).toHaveBeenCalledTimes(2)
    })
  })

  it('tells the window after each command, so it reads the flights again, and not after a command that was refused', () => {
    const changed = vi.fn()
    const ok = twinFlightQueries(fakeControl(), changed)
    ok['flight.fly']('u')
    ok['flight.start']('u')
    ok['flight.finish']()
    ok['flight.stop']()
    ok['flight.cancel']('u')
    ok['flight.setDestination']('u', 'EGCC')
    ok['flight.setDeparture']('u', null)
    expect(changed).toHaveBeenCalledTimes(7)
    const refused = vi.fn()
    const failing = twinFlightQueries(
      {
        ...fakeControl(),
        fly: vi.fn(() => {
          throw new Error('Unknown flight')
        })
      },
      refused
    )
    expect(() => failing['flight.fly']('u')).toThrow('Unknown flight')
    expect(() => failing['flight.fly'](5)).toThrow('Invalid flight')
    expect(refused).not.toHaveBeenCalled()
  })

  it('exposes them as lookups that check their argument', () => {
    const queries = twinFlightQueries(fakeControl())
    expect(Object.keys(queries).sort()).toEqual([
      'flight.cancel',
      'flight.finish',
      'flight.fly',
      'flight.setDeparture',
      'flight.setDestination',
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
