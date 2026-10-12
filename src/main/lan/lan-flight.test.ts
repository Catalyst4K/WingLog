import { describe, expect, it } from 'vitest'
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

  it('gives the active flight, its airports and OFP, and its recorded track', () => {
    const db = freshDb()
    const aircraftId = createAircraft(db, { registration: '9V-SKA', icaoType: 'A388' }).id
    const flight = createFlight(db, {
      aircraftId,
      depIcao: 'WSSS',
      arrIcao: 'EGLL',
      ofpJson: '{"general":{}}',
      status: 'active'
    })
    const snapshot = lanFlightSnapshot(db, flight.id)
    expect(snapshot?.flight).toEqual({
      flightId: flight.id,
      depIcao: 'WSSS',
      arrIcao: 'EGLL',
      ofpJson: '{"general":{}}'
    })
    expect(snapshot?.trackPoints).toEqual([])
  })
})
