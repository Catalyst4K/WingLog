import { describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createDb } from '../db/client'
import { createAircraft } from '../db/aircraft-repo'
import { createFlight } from '../db/flight-repo'
import { lanFlightSnapshot } from './lan-flight'

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
