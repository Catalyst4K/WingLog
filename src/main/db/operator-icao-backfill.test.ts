import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { findAirlineForOperator } from '../airlines/airline-search'
import { createDb, type WingLogDb } from './client'
import { createAircraft, deleteAircraft, getAircraftByRegistration } from './aircraft-repo'
import { aircraft } from './schema'
import { eq } from 'drizzle-orm'
import { backfillOperatorIcao } from './operator-icao-backfill'

describe('backfillOperatorIcao', () => {
  let db: WingLogDb

  beforeEach(() => {
    const created = createDb(':memory:')
    migrate(created.db, { migrationsFolder: 'drizzle' })
    db = created.db
  })

  const updatedAtOf = (registration: string): string | null | undefined =>
    db.select().from(aircraft).where(eq(aircraft.registration, registration)).get()?.updatedAt

  const icaoOf = (registration: string): string | null | undefined =>
    getAircraftByRegistration(db, registration)?.operatorIcao

  it('fills the aircraft saved with an airline and its IATA code but no ICAO, as the older fleet was', () => {
    for (const [registration, operator, operatorIata] of [
      ['HL8275', 'Korean Air', 'KE'],
      ['G-XWBS', 'British Airways', 'BA'],
      ['B-HYB', 'Cathay Dragon', 'KA'],
      ['9V-SGG', 'Singapore Airlines', 'SQ']
    ] as const) {
      createAircraft(db, { registration, icaoType: 'A320', operator, operatorIata })
    }

    const filled = backfillOperatorIcao(db, findAirlineForOperator)

    expect(filled).toEqual(['HL8275', 'G-XWBS', 'B-HYB', '9V-SGG'])
    expect(icaoOf('HL8275')).toBe('KAL')
    expect(icaoOf('G-XWBS')).toBe('BAW')
    expect(icaoOf('B-HYB')).toBe('HDA')
    expect(icaoOf('9V-SGG')).toBe('SIA')
  })

  it('leaves an aircraft that has an ICAO, one with no airline, and one the list cannot place', () => {
    createAircraft(db, {
      registration: 'G-HAVE',
      icaoType: 'A320',
      operator: 'British Airways',
      operatorIata: 'BA',
      operatorIcao: 'XMS'
    })
    createAircraft(db, { registration: 'G-NONE', icaoType: 'A320' })
    createAircraft(db, { registration: 'G-ODD', icaoType: 'A320', operator: 'My Own Virtual Airline' })

    expect(backfillOperatorIcao(db, findAirlineForOperator)).toEqual([])

    expect(icaoOf('G-HAVE')).toBe('XMS')
    expect(icaoOf('G-NONE')).toBeNull()
    expect(icaoOf('G-ODD')).toBeNull()
  })

  it('does not touch a deleted aircraft, and touches nothing the second time', () => {
    const gone = createAircraft(db, {
      registration: 'G-GONE',
      icaoType: 'A320',
      operator: 'Korean Air',
      operatorIata: 'KE'
    })
    deleteAircraft(db, gone.id)
    createAircraft(db, {
      registration: 'G-LIVE',
      icaoType: 'A320',
      operator: 'Korean Air',
      operatorIata: 'KE'
    })

    expect(backfillOperatorIcao(db, findAirlineForOperator)).toEqual(['G-LIVE'])
    const stamp = updatedAtOf('G-LIVE')
    expect(backfillOperatorIcao(db, findAirlineForOperator)).toEqual([])
    expect(updatedAtOf('G-LIVE')).toBe(stamp)
  })

  it('counts as a change that syncs: the row gets a new updatedAt', () => {
    createAircraft(db, {
      registration: 'G-SYNC',
      icaoType: 'A320',
      operator: 'Korean Air',
      operatorIata: 'KE'
    })
    db.update(aircraft).set({ updatedAt: '2020-01-01T00:00:00.000Z' }).run()

    backfillOperatorIcao(db, findAirlineForOperator)

    expect((updatedAtOf('G-SYNC') ?? '') > '2020-01-01T00:00:00.000Z').toBe(true)
  })
})
