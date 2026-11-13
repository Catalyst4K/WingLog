import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { findAirlineForOperator } from '../airlines/airline-search'
import { createDb, type WingLogDb } from './client'
import {
  createAircraft,
  deleteAircraft,
  fillMissingOperatorIcao,
  getAircraftByRegistration
} from './aircraft-repo'
import { latestChangeSeq } from './sync-change-repo'
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

  it('leaves an aircraft that has an ICAO, one with no airline, a name or a code on its own, and one the list cannot place', () => {
    createAircraft(db, {
      registration: 'G-HAVE',
      icaoType: 'A320',
      operator: 'British Airways',
      operatorIata: 'BA',
      operatorIcao: 'XMS'
    })
    createAircraft(db, { registration: 'G-NONE', icaoType: 'A320' })
    createAircraft(db, { registration: 'G-TYPED', icaoType: 'A320', operator: 'Jet Airways' })
    createAircraft(db, { registration: 'I-CODE', icaoType: 'A320', operatorIata: 'AZ' })
    createAircraft(db, {
      registration: 'G-ODD',
      icaoType: 'A320',
      operator: 'My Own Virtual Airline',
      operatorIata: 'ZZ'
    })
    createAircraft(db, {
      registration: 'I-WRNG',
      icaoType: 'A320',
      operator: 'ITA Airways',
      operatorIata: 'AZ'
    })

    expect(backfillOperatorIcao(db, findAirlineForOperator)).toEqual([])

    expect(icaoOf('G-HAVE')).toBe('XMS')
    expect(icaoOf('G-NONE')).toBeNull()
    expect(icaoOf('G-TYPED')).toBeNull()
    expect(icaoOf('I-CODE')).toBeNull()
    expect(icaoOf('G-ODD')).toBeNull()
    expect(icaoOf('I-WRNG')).toBeNull()
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

  it('is not a change that syncs: updatedAt and the change counter stay, so the row is not sent and cannot outrank a newer edit elsewhere', () => {
    createAircraft(db, {
      registration: 'G-SYNC',
      icaoType: 'A320',
      operator: 'Korean Air',
      operatorIata: 'KE',
      simbriefAirframeId: '123_KEPT'
    })
    const lastSynced = '2020-01-01T00:00:00.000Z'
    db.update(aircraft).set({ updatedAt: lastSynced }).run()
    const seq = latestChangeSeq(db, 'aircraft')

    expect(backfillOperatorIcao(db, findAirlineForOperator)).toEqual(['G-SYNC'])

    expect(icaoOf('G-SYNC')).toBe('KAL')
    expect(updatedAtOf('G-SYNC')).toBe(lastSynced)
    expect(getAircraftByRegistration(db, 'G-SYNC')?.simbriefAirframeId).toBe('123_KEPT')
    expect(latestChangeSeq(db, 'aircraft')).toBe(seq)
  })
})

describe('fillMissingOperatorIcao', () => {
  let db: WingLogDb

  beforeEach(() => {
    const created = createDb(':memory:')
    migrate(created.db, { migrationsFolder: 'drizzle' })
    db = created.db
  })

  it('fills a missing or blank ICAO, and never replaces one that is there', () => {
    const missing = createAircraft(db, { registration: 'G-EMPT', icaoType: 'A320' })
    const blank = createAircraft(db, { registration: 'G-BLNK', icaoType: 'A320' })
    db.update(aircraft).set({ operatorIcao: '' }).where(eq(aircraft.id, blank.id)).run()
    const set = createAircraft(db, { registration: 'G-SET', icaoType: 'A320', operatorIcao: 'XMS' })

    expect(fillMissingOperatorIcao(db, missing.id, 'BAW')).toBe(true)
    expect(fillMissingOperatorIcao(db, blank.id, 'BAW')).toBe(true)
    expect(fillMissingOperatorIcao(db, set.id, 'BAW')).toBe(false)
    expect(fillMissingOperatorIcao(db, 9999, 'BAW')).toBe(false)

    expect(getAircraftByRegistration(db, 'G-EMPT')?.operatorIcao).toBe('BAW')
    expect(getAircraftByRegistration(db, 'G-BLNK')?.operatorIcao).toBe('BAW')
    expect(getAircraftByRegistration(db, 'G-SET')?.operatorIcao).toBe('XMS')
  })
})
