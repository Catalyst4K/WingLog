import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createAircraft } from '../db/aircraft-repo'
import { createDb, type WingLogDb } from '../db/client'
import { createFlight, getFlight } from '../db/flight-repo'
import { setFlightOnline } from './flight-online'

describe('setFlightOnline', () => {
  let db: WingLogDb

  beforeEach(() => {
    db = createDb(':memory:').db
    migrate(db, { migrationsFolder: 'drizzle' })
  })

  it('records the network and callsign on that flight only, and a flight starts with neither', () => {
    const aircraft = createAircraft(db, { registration: 'G-TEST', icaoType: 'A320' })
    const flown = createFlight(db, { aircraftId: aircraft.id, depIcao: 'EGLL', arrIcao: 'LFPG' })
    const other = createFlight(db, { aircraftId: aircraft.id, depIcao: 'EGLL', arrIcao: 'EGCC' })
    expect(getFlight(db, flown.id)).toMatchObject({ onlineNetwork: null, onlineCallsign: null })
    setFlightOnline(db, flown.id, 'ivao', 'BAW123')
    expect(getFlight(db, flown.id)).toMatchObject({ onlineNetwork: 'ivao', onlineCallsign: 'BAW123' })
    expect(getFlight(db, other.id)).toMatchObject({ onlineNetwork: null, onlineCallsign: null })
  })
})
