import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import { createDb, type WingLogDb } from './../db/client'
import { createAircraft } from '../db/aircraft-repo'
import { createFlight } from '../db/flight-repo'
import { flight as flightTable } from '../db/schema'
import { buildFlightMatchWindow } from './flight-window'

describe('buildFlightMatchWindow', () => {
  let db: WingLogDb

  beforeEach(() => {
    const created = createDb(':memory:')
    migrate(created.db, { migrationsFolder: 'drizzle' })
    db = created.db
  })

  it('returns null for a flight that does not exist', () => {
    expect(buildFlightMatchWindow(db, 999_999)).toBeNull()
  })

  it('falls back to scheduled times when actual times are not recorded yet', () => {
    const aircraft = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' })
    const flight = createFlight(db, {
      aircraftId: aircraft.id,
      depIcao: 'EGLL',
      arrIcao: 'EGCC',
      schedOutUtc: '2026-09-06T10:00:00.000Z',
      schedInUtc: '2026-09-06T11:00:00.000Z'
    })

    expect(buildFlightMatchWindow(db, flight.id)).toEqual({
      depIcao: 'EGLL',
      arrIcao: 'EGCC',
      registration: 'G-ABCD',
      windowStartUtc: '2026-09-06T10:00:00.000Z',
      windowEndUtc: '2026-09-06T11:00:00.000Z'
    })
  })

  it('prefers actual times over scheduled ones once tracking has recorded them', () => {
    const aircraft = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' })
    const flight = createFlight(db, {
      aircraftId: aircraft.id,
      depIcao: 'EGLL',
      arrIcao: 'EGCC',
      schedOutUtc: '2026-09-06T10:00:00.000Z',
      schedInUtc: '2026-09-06T11:00:00.000Z'
    })
    db.update(flightTable)
      .set({ actualOutUtc: '2026-09-06T10:05:00.000Z', actualInUtc: '2026-09-06T11:10:00.000Z' })
      .where(eq(flightTable.id, flight.id))
      .run()

    const window = buildFlightMatchWindow(db, flight.id)
    expect(window?.windowStartUtc).toBe('2026-09-06T10:05:00.000Z')
    expect(window?.windowEndUtc).toBe('2026-09-06T11:10:00.000Z')
  })
})
