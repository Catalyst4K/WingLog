import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { FetchedAirportNavdata } from '../navdata/sim-facilities-fetch'
import { createDb, type WingLogDb } from './client'
import {
  hasCachedAirport,
  listCachedProcedureLegs,
  listCachedProcedures,
  listCachedRunways,
  replaceAirportNavdata
} from './navdata-repo'

function fetched(overrides: Partial<FetchedAirportNavdata> = {}): FetchedAirportNavdata {
  return {
    icao: 'EGLL',
    runways: [
      {
        latitude: 51.4775,
        longitude: -0.4614,
        headingDeg: 270,
        lengthM: 3902,
        widthM: 50,
        surface: 2,
        primaryIdent: '27R',
        secondaryIdent: '09L'
      }
    ],
    departures: [
      {
        name: 'BPK7F',
        runwayIdents: ['27R'],
        transitionNames: ['CLEEE'],
        legs: [
          {
            type: 4,
            fixIdent: 'BPK',
            fixType: 'W',
            fixLatitude: 51.5,
            fixLongitude: -0.2,
            turnDirection: 0,
            courseDeg: 270,
            altitude1: 6000,
            altitude2: 0,
            speedLimit: 250
          }
        ]
      }
    ],
    arrivals: [],
    ...overrides
  }
}

describe('navdata repo', () => {
  let db: WingLogDb

  beforeEach(() => {
    const created = createDb(':memory:')
    migrate(created.db, { migrationsFolder: 'drizzle' })
    db = created.db
  })

  it('starts with no cached navdata for an airport', () => {
    expect(hasCachedAirport(db, 'EGLL')).toBe(false)
    expect(listCachedRunways(db, 'EGLL')).toEqual([])
    expect(listCachedProcedures(db, 'EGLL', 'sid', null)).toEqual([])
  })

  it('caches runways derived into both ends, and SID procedures with their transitions', () => {
    replaceAirportNavdata(db, 'EGLL', fetched(), '2026-09-08T12:00:00.000Z')

    expect(hasCachedAirport(db, 'EGLL')).toBe(true)

    const runways = listCachedRunways(db, 'EGLL')
    expect(runways).toHaveLength(2)
    expect(runways.map((r) => r.ident).sort()).toEqual(['09L', '27R'])

    const sids = listCachedProcedures(db, 'EGLL', 'sid', null)
    expect(sids).toEqual([{ identifier: 'BPK7F', transition: 'CLEEE' }])

    const legs = listCachedProcedureLegs(db, 'EGLL', 'sid', 'BPK7F')
    expect(legs).toHaveLength(1)
    expect(legs[0]).toMatchObject({ fixIdent: 'BPK', fixType: 'W' })
  })

  it('filters SIDs by runway, treating a procedure with no runway transitions as applying to any runway', () => {
    replaceAirportNavdata(
      db,
      'EGLL',
      fetched({
        departures: [
          { name: 'RUNWAY_SPECIFIC', runwayIdents: ['27R'], transitionNames: [], legs: [] },
          { name: 'ANY_RUNWAY', runwayIdents: [], transitionNames: [], legs: [] }
        ]
      }),
      '2026-09-08T12:00:00.000Z'
    )

    const forRunway = listCachedProcedures(db, 'EGLL', 'sid', '27R').map((p) => p.identifier)
    expect(forRunway).toContain('RUNWAY_SPECIFIC')
    expect(forRunway).toContain('ANY_RUNWAY')

    const forOtherRunway = listCachedProcedures(db, 'EGLL', 'sid', '09L').map((p) => p.identifier)
    expect(forOtherRunway).not.toContain('RUNWAY_SPECIFIC')
    expect(forOtherRunway).toContain('ANY_RUNWAY')
  })

  it('replaces the cache wholesale on a second fetch rather than accumulating rows', () => {
    replaceAirportNavdata(db, 'EGLL', fetched(), '2026-09-08T12:00:00.000Z')
    replaceAirportNavdata(
      db,
      'EGLL',
      fetched({ departures: [{ name: 'NEW_SID', runwayIdents: [], transitionNames: [], legs: [] }] }),
      '2026-09-08T13:00:00.000Z'
    )

    const sids = listCachedProcedures(db, 'EGLL', 'sid', null)
    expect(sids).toEqual([{ identifier: 'NEW_SID', transition: null }])
    // The stale BPK7F's legs must have gone with it — no orphaned rows left in
    // navdata_procedure_leg from the first fetch.
    expect(listCachedProcedureLegs(db, 'EGLL', 'sid', 'BPK7F')).toEqual([])
  })

  it('keeps a different airport untouched by a replace', () => {
    replaceAirportNavdata(db, 'EGLL', fetched(), '2026-09-08T12:00:00.000Z')
    replaceAirportNavdata(db, 'VHHH', fetched({ icao: 'VHHH' }), '2026-09-08T12:00:00.000Z')

    expect(listCachedRunways(db, 'EGLL')).toHaveLength(2)
    expect(listCachedRunways(db, 'VHHH')).toHaveLength(2)
  })
})
