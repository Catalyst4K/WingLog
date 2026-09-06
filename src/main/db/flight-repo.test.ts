import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createDb, type FlightdeckDb } from './client'
import { createAircraft, getAircraftByRegistration } from './aircraft-repo'
import { createLanding, getLandingByFlight, type NewLanding } from './landing-repo'
import { createTrackPoint, listTrackPoints } from './track-point-repo'
import {
  abandonAllPlanned,
  abandonFlight,
  completeFlight,
  createFlight,
  createHistoricalFlight,
  deleteFlight,
  finalizeFuelOut,
  getFleetStats,
  getFlight,
  listCompletedFlights,
  listFlights,
  recordOff,
  recordOn,
  startFlight
} from './flight-repo'

function newLandingFixture(flightId: number): NewLanding {
  return {
    flightId,
    touchdownTsUtc: '2026-09-01T12:00:00.000Z',
    verticalSpeedMs: -1.5,
    gForce: 1.2,
    pitchDeg: 3,
    bankDeg: 0,
    headingTrueDeg: 70,
    indicatedAirspeedMs: 65,
    groundSpeedMs: 65,
    windSpeedMs: 3,
    windDirectionDeg: 250,
    headwindMs: 2,
    crosswindMs: 1,
    crabDeg: 4,
    runwayIdent: '07L',
    distanceFromThresholdM: 120,
    centrelineOffsetM: 2,
    flapSetting: 3,
    touchdownSource: 'derived'
  }
}

describe('flight repo', () => {
  let db: FlightdeckDb
  let aircraftId: number

  beforeEach(() => {
    const created = createDb(':memory:')
    migrate(created.db, { migrationsFolder: 'drizzle' })
    db = created.db
    aircraftId = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' }).id
  })

  it('starts empty', () => {
    expect(listFlights(db)).toEqual([])
  })

  it('creates a planned flight with defaults applied', () => {
    const created = createFlight(db, { aircraftId, depIcao: 'EGLL', arrIcao: 'VHHH' })

    expect(created.id).toBeTypeOf('number')
    expect(created.status).toBe('planned')
    expect(created.aircraftId).toBe(aircraftId)
    expect(created.depIcao).toBe('EGLL')
    expect(created.arrIcao).toBe('VHHH')
    expect(created.altnIcao).toBeNull()
    expect(listFlights(db)).toEqual([created])
  })

  it('stores OFP-derived fields', () => {
    const created = createFlight(db, {
      aircraftId,
      depIcao: 'EGLL',
      arrIcao: 'VHHH',
      altnIcao: 'VMMC',
      flightNumber: 'BAW31',
      cruiseAltM: 10058.4,
      fuelPlannedKg: 85029,
      pax: 328,
      ofpId: '184216371',
      ofpJson: '{"raw":true}'
    })

    expect(created.flightNumber).toBe('BAW31')
    expect(created.cruiseAltM).toBe(10058.4)
    expect(created.fuelPlannedKg).toBe(85029)
    expect(created.pax).toBe(328)
    expect(created.ofpId).toBe('184216371')
    expect(created.ofpJson).toBe('{"raw":true}')
  })

  it('rejects a flight for a nonexistent aircraft', () => {
    expect(() => createFlight(db, { aircraftId: 99999, depIcao: 'EGLL', arrIcao: 'VHHH' })).toThrow()
  })

  it('lists newest first', () => {
    const first = createFlight(db, { aircraftId, depIcao: 'EGLL', arrIcao: 'VHHH' })
    const second = createFlight(db, { aircraftId, depIcao: 'VHHH', arrIcao: 'EGLL' })
    expect(listFlights(db).map((f) => f.id)).toEqual([second.id, first.id])
  })

  it('gets a single flight by id', () => {
    const created = createFlight(db, { aircraftId, depIcao: 'EGLL', arrIcao: 'VHHH' })
    expect(getFlight(db, created.id)).toEqual(created)
    expect(getFlight(db, 99999)).toBeUndefined()
  })

  it('inserts a historical flight already completed, with block time derived from its timestamps', () => {
    const created = createHistoricalFlight(db, {
      aircraftId,
      depIcao: 'EGLL',
      arrIcao: 'RKSI',
      flightNumber: 'KAL667',
      actualOutUtc: '2026-08-21T22:16:00.000Z',
      actualInUtc: '2026-08-22T10:50:00.000Z'
    })

    expect(created.status).toBe('completed')
    expect(created.flightNumber).toBe('KAL667')
    expect(created.blockMinutes).toBe(754) // 22:16 -> next day 10:50
    expect(created.airMinutes).toBeNull() // no off/on data in a summary logbook export
    expect(created.fuelBurnKg).toBeNull()
  })

  describe('tracking lifecycle', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-09-01T12:00:00Z'))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('walks a flight from planned through completed with correct block/air time and fuel burn', () => {
      const created = createFlight(db, { aircraftId, depIcao: 'EGLL', arrIcao: 'VHHH' })

      const started = startFlight(db, created.id, 10000)
      expect(started?.status).toBe('active')
      expect(started?.actualOutUtc).toBe('2026-09-01T12:00:00.000Z')
      expect(started?.fuelOutKg).toBe(10000)

      vi.setSystemTime(new Date('2026-09-01T12:10:00Z'))
      recordOff(db, created.id)

      vi.setSystemTime(new Date('2026-09-01T13:40:00Z'))
      recordOn(db, created.id)

      vi.setSystemTime(new Date('2026-09-01T13:50:00Z'))
      const completed = completeFlight(db, created.id, 4000)

      expect(completed?.status).toBe('completed')
      expect(completed?.actualOffUtc).toBe('2026-09-01T12:10:00.000Z')
      expect(completed?.actualOnUtc).toBe('2026-09-01T13:40:00.000Z')
      expect(completed?.actualInUtc).toBe('2026-09-01T13:50:00.000Z')
      expect(completed?.blockMinutes).toBe(110) // 12:00 -> 13:50
      expect(completed?.airMinutes).toBe(90) // 12:10 -> 13:40
      expect(completed?.fuelBurnKg).toBe(6000) // 10000 - 4000
    })

    it('finalizeFuelOut corrects the fuel_out_kg written by startFlight, and feeds into a later fuel-burn calculation', () => {
      const created = createFlight(db, { aircraftId, depIcao: 'EGLL', arrIcao: 'VHHH' })
      startFlight(db, created.id, 10187) // provisional — a stale/pre-service reading
      finalizeFuelOut(db, created.id, 6504) // corrected once past ground fuel service

      expect(getFlight(db, created.id)?.fuelOutKg).toBe(6504)

      const completed = completeFlight(db, created.id, 3239)
      expect(completed?.fuelBurnKg).toBe(3265) // 6504 - 3239, not 10187 - 3239
    })

    it("updates the aircraft's currentIcao to the arrival airport on completion", () => {
      const created = createFlight(db, { aircraftId, depIcao: 'EGLL', arrIcao: 'VHHH' })
      startFlight(db, created.id, 10000)
      completeFlight(db, created.id, 4000)

      expect(getAircraftByRegistration(db, 'G-ABCD')?.currentIcao).toBe('VHHH')
    })

    it('marks a cancelled flight abandoned rather than completed', () => {
      const created = createFlight(db, { aircraftId, depIcao: 'EGLL', arrIcao: 'VHHH' })
      startFlight(db, created.id, 10000)
      const abandoned = abandonFlight(db, created.id)
      expect(abandoned?.status).toBe('abandoned')
    })

    it('abandonAllPlanned abandons every planned flight, leaving other statuses untouched', () => {
      const planned = createFlight(db, { aircraftId, depIcao: 'EGLL', arrIcao: 'VHHH' })
      const alsoPlanned = createFlight(db, { aircraftId, depIcao: 'EGLL', arrIcao: 'EDDF' })
      const active = createFlight(db, { aircraftId, depIcao: 'EGLL', arrIcao: 'LFPG' })
      startFlight(db, active.id, 10000)

      abandonAllPlanned(db)

      expect(getFlight(db, planned.id)?.status).toBe('abandoned')
      expect(getFlight(db, alsoPlanned.id)?.status).toBe('abandoned')
      expect(getFlight(db, active.id)?.status).toBe('active')
    })

    it('deleteFlight removes the flight and its landing/track-point dependents', () => {
      const created = createFlight(db, { aircraftId, depIcao: 'EGLL', arrIcao: 'VHHH' })
      startFlight(db, created.id, 10000)
      createTrackPoint(db, {
        flightId: created.id,
        tsUtc: '2026-09-01T11:00:00.000Z',
        latitude: 22.3,
        longitude: 113.9,
        altitudeM: 0,
        altitudeAglM: 0,
        indicatedAirspeedMs: 0,
        machSpeed: 0,
        groundSpeedMs: 0,
        verticalSpeedMs: 0,
        headingTrueDeg: 70,
        pitchDeg: 0,
        bankDeg: 0,
        phase: 'preflight',
        onGround: true,
        fuelKg: 10000,
        gForce: 1,
        windSpeedMs: 0,
        windDirectionDeg: 0
      })
      createLanding(db, newLandingFixture(created.id))
      completeFlight(db, created.id, 3700)

      expect(listTrackPoints(db, created.id)).toHaveLength(1)
      expect(getLandingByFlight(db, created.id)).toBeDefined()

      deleteFlight(db, created.id)

      expect(getFlight(db, created.id)).toBeUndefined()
      expect(listTrackPoints(db, created.id)).toEqual([])
      expect(getLandingByFlight(db, created.id)).toBeUndefined()
    })

    it('deleteFlight on a flight with no dependents is a no-op beyond removing the row', () => {
      const created = createFlight(db, { aircraftId, depIcao: 'EGLL', arrIcao: 'VHHH' })
      deleteFlight(db, created.id)
      expect(getFlight(db, created.id)).toBeUndefined()
    })
  })

  describe('logbook queries', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-09-01T12:00:00Z'))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    /** Drives a flight from planned through completed, advancing the fake clock by `blockMinutes`. */
    function flyAndComplete(
      forAircraftId: number,
      arrIcao: string,
      blockMinutes: number,
      fuelBurnKg: number
    ): void {
      const created = createFlight(db, { aircraftId: forAircraftId, depIcao: 'EGLL', arrIcao })
      startFlight(db, created.id, 10000)
      vi.setSystemTime(new Date(Date.now() + blockMinutes * 60_000))
      completeFlight(db, created.id, 10000 - fuelBurnKg)
    }

    it('lists only completed flights, newest actualInUtc first', () => {
      createFlight(db, { aircraftId, depIcao: 'EGLL', arrIcao: 'VHHH' }) // stays planned
      flyAndComplete(aircraftId, 'EGCC', 30, 500)
      vi.setSystemTime(new Date('2026-09-01T14:00:00Z'))
      flyAndComplete(aircraftId, 'EGPH', 45, 700)

      const completed = listCompletedFlights(db)
      expect(completed).toHaveLength(2)
      expect(completed.map((f) => f.arrIcao)).toEqual(['EGPH', 'EGCC'])
      expect(completed.every((f) => f.status === 'completed')).toBe(true)
    })

    it('returns no fleet stats when nothing has completed', () => {
      const created = createFlight(db, { aircraftId, depIcao: 'EGLL', arrIcao: 'VHHH' })
      startFlight(db, created.id, 10000) // active, not completed
      expect(getFleetStats(db)).toEqual([])
    })

    it('aggregates hours/cycles per aircraft from completed flights only', () => {
      const secondAircraftId = createAircraft(db, {
        registration: 'G-WXYZ',
        icaoType: 'B738'
      }).id

      flyAndComplete(aircraftId, 'EGCC', 60, 500) // 1h
      vi.setSystemTime(new Date('2026-09-01T14:00:00Z'))
      flyAndComplete(aircraftId, 'EGPH', 30, 300) // +0.5h, most recent for this tail
      vi.setSystemTime(new Date('2026-09-01T15:00:00Z'))
      flyAndComplete(secondAircraftId, 'EGKK', 90, 900) // 1.5h, one cycle

      const stats = getFleetStats(db)
      expect(stats).toHaveLength(2)

      const first = stats.find((s) => s.aircraftId === aircraftId)
      expect(first?.registration).toBe('G-ABCD')
      expect(first?.totalCycles).toBe(2)
      expect(first?.totalHours).toBeCloseTo(1.5)
      expect(first?.lastArrIcao).toBe('EGPH') // most recent completed flight for this tail

      const second = stats.find((s) => s.aircraftId === secondAircraftId)
      expect(second?.registration).toBe('G-WXYZ')
      expect(second?.totalCycles).toBe(1)
      expect(second?.totalHours).toBeCloseTo(1.5)
      expect(second?.lastArrIcao).toBe('EGKK')

      // Sorted by registration.
      expect(stats.map((s) => s.registration)).toEqual(['G-ABCD', 'G-WXYZ'])
    })

    it('omits an aircraft with no completed flights, even if it has a planned one', () => {
      createAircraft(db, { registration: 'G-IDLE', icaoType: 'A320' })
      flyAndComplete(aircraftId, 'EGCC', 30, 500)

      const stats = getFleetStats(db)
      expect(stats.map((s) => s.registration)).toEqual(['G-ABCD'])
    })
  })
})
