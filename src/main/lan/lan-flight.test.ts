import { describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createDb } from '../db/client'
import { createAircraft } from '../db/aircraft-repo'
import { createFlight } from '../db/flight-repo'
import { lanFlightKey, lanFlightSnapshot } from './lan-flight'

function freshDb() {
  const { db } = createDb(':memory:')
  migrate(db, { migrationsFolder: 'drizzle' })
  return db
}

describe('lanFlightSnapshot', () => {
  it('is null when nothing is being tracked', () => {
    expect(lanFlightSnapshot(freshDb(), undefined)).toBeNull()
  })

  it('is null for a flight that no longer exists', () => {
    expect(lanFlightSnapshot(freshDb(), 999)).toBeNull()
  })

  it('previews the newest planned flight when nothing is being tracked, and the tracked one otherwise', () => {
    const db = freshDb()
    const aircraftId = createAircraft(db, { registration: '9V-SKA', icaoType: 'A388' }).id
    const older = createFlight(db, { aircraftId, depIcao: 'WSSS', arrIcao: 'EGLL' })
    const newer = createFlight(db, { aircraftId, depIcao: 'EGLL', arrIcao: 'WSSS', flightNumber: 'SIA322' })
    expect(lanFlightSnapshot(db, undefined)?.flight).toMatchObject({
      flightId: newer.id,
      flightNumber: 'SIA322'
    })
    expect(lanFlightSnapshot(db, older.id)?.flight.flightId).toBe(older.id)
  })

  it('is null with nothing tracked and nothing planned (an active or finished flight is not previewed)', () => {
    const db = freshDb()
    const aircraftId = createAircraft(db, { registration: '9V-SKA', icaoType: 'A388' }).id
    createFlight(db, { aircraftId, depIcao: 'WSSS', arrIcao: 'EGLL', status: 'completed' })
    expect(lanFlightSnapshot(db, undefined)).toBeNull()
  })

  it('has a key that changes with the flight shown and with what is saved on it', () => {
    const db = freshDb()
    expect(lanFlightKey(db, undefined)).toBe('none')
    const aircraftId = createAircraft(db, { registration: '9V-SKA', icaoType: 'A388' }).id
    const first = createFlight(db, { aircraftId, depIcao: 'WSSS', arrIcao: 'EGLL' })
    const keyOne = lanFlightKey(db, undefined)
    expect(keyOne).not.toBe('none')
    expect(lanFlightKey(db, undefined)).toBe(keyOne)
    createFlight(db, { aircraftId, depIcao: 'EGLL', arrIcao: 'WSSS' })
    expect(lanFlightKey(db, undefined)).not.toBe(keyOne)
    expect(lanFlightKey(db, first.id)).toBe(keyOne)
    expect(lanFlightKey(db, 999)).toBe('none')
  })

  it('has no registration or type for a free flight with no fleet aircraft', () => {
    const db = freshDb()
    const aircraftId = createAircraft(db, { registration: 'G-FREE', icaoType: 'C172' }).id
    const flight = createFlight(db, { aircraftId, depIcao: 'EGLL', arrIcao: 'EGKK', status: 'active' })
    db.run(sql`UPDATE flight SET aircraft_id = NULL WHERE id = ${flight.id}`)
    expect(lanFlightSnapshot(db, flight.id)?.flight).toMatchObject({
      registration: null,
      icaoType: null,
      flightNumber: null
    })
  })

  it('gives the active flight, its airports and OFP, and its recorded track', () => {
    const db = freshDb()
    const aircraftId = createAircraft(db, { registration: '9V-SKA', icaoType: 'A388' }).id
    const flight = createFlight(db, {
      aircraftId,
      depIcao: 'WSSS',
      arrIcao: 'EGLL',
      flightNumber: 'SIA321',
      ofpJson: '{"general":{}}',
      status: 'active'
    })
    const snapshot = lanFlightSnapshot(db, flight.id)
    expect(snapshot?.flight).toEqual({
      flightId: flight.id,
      depIcao: 'WSSS',
      arrIcao: 'EGLL',
      flightNumber: 'SIA321',
      schedInUtc: null,
      registration: '9V-SKA',
      icaoType: 'A388',
      ofpJson: '{"general":{}}',
      selection: {
        departureRunway: null,
        sidIdent: null,
        sidTransition: null,
        starIdent: null,
        starTransition: null,
        approachIdent: null,
        approachTransition: null,
        arrivalIcao: null
      }
    })
    expect(snapshot?.trackPoints).toEqual([])
  })

  it('gives the flight’s saved procedures, or the ones the PC’s window chose when it has chosen', () => {
    const db = freshDb()
    const aircraftId = createAircraft(db, { registration: '9V-SKA', icaoType: 'A388' }).id
    const flight = createFlight(db, {
      aircraftId,
      depIcao: 'WSSS',
      arrIcao: 'EGLL',
      status: 'active',
      selectedDepartureRunway: '02L',
      selectedSidIdent: 'KAMI2A',
      selectedStarIdent: 'SIER7B',
      selectedApproachIdent: 'ILS 27L',
      selectedArrivalIcao: null
    })
    expect(lanFlightSnapshot(db, flight.id)?.flight.selection).toMatchObject({
      departureRunway: '02L',
      sidIdent: 'KAMI2A',
      starIdent: 'SIER7B',
      approachIdent: 'ILS 27L'
    })
    const chosen = {
      departureRunway: '02C',
      sidIdent: null,
      sidTransition: null,
      starIdent: 'TEBU1B',
      starTransition: null,
      approachIdent: null,
      approachTransition: null,
      arrivalIcao: null
    }
    expect(lanFlightSnapshot(db, flight.id, chosen)?.flight.selection).toEqual(chosen)
  })
})
