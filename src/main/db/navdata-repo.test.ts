import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { FetchedAirportNavdata, FetchedApproach, FetchedProcedure } from '../navdata/sim-facilities-fetch'
import type { ParsedLeg } from '../sim/facility-fields'
import { createDb, type WingLogDb } from './client'
import {
  hasCachedAirport,
  listCachedProcedureLegs,
  listCachedProcedures,
  listCachedRunways,
  replaceAirportNavdata
} from './navdata-repo'

function leg(fixIdent: string, overrides: Partial<ParsedLeg> = {}): ParsedLeg {
  return {
    type: 4,
    fixIdent,
    fixType: 'W',
    fixLatitude: 51.5,
    fixLongitude: -0.2,
    turnDirection: 0,
    courseDeg: 270,
    altitude1: 6000,
    altitude2: 0,
    speedLimit: 250,
    ...overrides
  }
}

function procedure(fields: Pick<FetchedProcedure, 'name'> & Partial<FetchedProcedure>): FetchedProcedure {
  return {
    runwayTransitions: [],
    enrouteTransitions: [],
    commonLegs: [],
    expected: { runwayTransitions: 0, enrouteTransitions: 0, approachLegs: 0 },
    ...fields
  }
}

function approach(fields: Pick<FetchedApproach, 'identifier' | 'runwayIdent'> & Partial<FetchedApproach>): FetchedApproach {
  return {
    transitions: [],
    finalLegs: [],
    expected: { transitions: 0, finalApproachLegs: 0, missedApproachLegs: 0 },
    ...fields
  }
}

function fetched(overrides: Partial<FetchedAirportNavdata> = {}): FetchedAirportNavdata {
  return {
    icao: 'EGLL',
    approaches: [],
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
      procedure({
        name: 'BPK7F',
        // Confirmed live shape for a real SID (docs/navdata-notes.md): its legs live
        // inside the one runway transition, not the procedure's own common list.
        runwayTransitions: [{ runwayIdent: '27R', legs: [leg('RWYFIX')] }],
        enrouteTransitions: [{ name: 'CLEEE', legs: [leg('ENRFIX')] }]
      })
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
  })

  it('assembles waypoints as runway-transition legs, then common legs, then enroute-transition legs', () => {
    replaceAirportNavdata(
      db,
      'EGLL',
      fetched({
        departures: [
          procedure({
            name: 'MIXED1A',
            runwayTransitions: [{ runwayIdent: '27R', legs: [leg('RWYFIX')] }],
            commonLegs: [leg('COMMON')],
            enrouteTransitions: [{ name: 'CLEEE', legs: [leg('ENRFIX')] }]
          })
        ]
      }),
      '2026-09-08T12:00:00.000Z'
    )

    // No runway/transition given — a procedure whose real legs live inside a specific
    // runway transition returns only its common legs, not a guessed-at runway's legs.
    expect(listCachedProcedureLegs(db, 'EGLL', 'sid', 'MIXED1A').map((l) => l.fixIdent)).toEqual(['COMMON'])

    expect(listCachedProcedureLegs(db, 'EGLL', 'sid', 'MIXED1A', '27R').map((l) => l.fixIdent)).toEqual([
      'RWYFIX',
      'COMMON'
    ])
    expect(listCachedProcedureLegs(db, 'EGLL', 'sid', 'MIXED1A', '27R', 'CLEEE').map((l) => l.fixIdent)).toEqual([
      'RWYFIX',
      'COMMON',
      'ENRFIX'
    ])
    // A runway that doesn't match this procedure's own transition contributes nothing.
    expect(listCachedProcedureLegs(db, 'EGLL', 'sid', 'MIXED1A', '09L').map((l) => l.fixIdent)).toEqual(['COMMON'])
  })

  it('returns a real SID\'s runway-transition legs only when the matching runway is given — the confirmed-live shape', () => {
    replaceAirportNavdata(db, 'EGLL', fetched(), '2026-09-08T12:00:00.000Z')

    expect(listCachedProcedureLegs(db, 'EGLL', 'sid', 'BPK7F')).toEqual([])
    expect(listCachedProcedureLegs(db, 'EGLL', 'sid', 'BPK7F', '27R').map((l) => l.fixIdent)).toEqual(['RWYFIX'])
    expect(listCachedProcedureLegs(db, 'EGLL', 'sid', 'BPK7F', '27R', 'CLEEE').map((l) => l.fixIdent)).toEqual([
      'RWYFIX',
      'ENRFIX'
    ])
  })

  it('filters SIDs by runway, treating a procedure with no runway transitions as applying to any runway', () => {
    replaceAirportNavdata(
      db,
      'EGLL',
      fetched({
        departures: [
          procedure({ name: 'RUNWAY_SPECIFIC', runwayTransitions: [{ runwayIdent: '27R', legs: [] }] }),
          procedure({ name: 'ANY_RUNWAY' })
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
    replaceAirportNavdata(db, 'EGLL', fetched({ departures: [procedure({ name: 'NEW_SID' })] }), '2026-09-08T13:00:00.000Z')

    const sids = listCachedProcedures(db, 'EGLL', 'sid', null)
    expect(sids).toEqual([{ identifier: 'NEW_SID', transition: null }])
    // The stale BPK7F's legs must have gone with it — no orphaned rows left in
    // navdata_procedure_leg from the first fetch.
    expect(listCachedProcedureLegs(db, 'EGLL', 'sid', 'BPK7F', '27R')).toEqual([])
  })

  it('caches an approach with its runway and transition names', () => {
    replaceAirportNavdata(
      db,
      'VHHH',
      fetched({
        icao: 'VHHH',
        approaches: [
          approach({
            identifier: 'RNAV Z 07R',
            runwayIdent: '07R',
            transitions: [{ name: 'LIMES', legs: [leg('LIMES'), leg('VH720')] }],
            finalLegs: [leg('VH720'), leg('RW07R')]
          })
        ]
      }),
      '2026-09-08T12:00:00.000Z'
    )

    expect(listCachedProcedures(db, 'VHHH', 'approach', null)).toEqual([{ identifier: 'RNAV Z 07R', transition: 'LIMES' }])
    expect(listCachedProcedures(db, 'VHHH', 'approach', '07R').map((p) => p.identifier)).toContain('RNAV Z 07R')
    expect(listCachedProcedures(db, 'VHHH', 'approach', '25L')).toEqual([])
  })

  it(
    'assembles an approach as transition legs then the final segment (reverse of a SID/STAR), ' +
      'dropping the duplicate fix at the boundary',
    () => {
      replaceAirportNavdata(
        db,
        'VHHH',
        fetched({
          icao: 'VHHH',
          approaches: [
            approach({
              identifier: 'RNAV Z 07R',
              runwayIdent: '07R',
              // VH720 is both the transition's own last leg and the final segment's first
              // leg — real ARINC 424 shape confirmed live 2026-09-08 (docs/navdata-notes.md).
              transitions: [{ name: 'LIMES', legs: [leg('LIMES'), leg('VH720')] }],
              finalLegs: [leg('VH720'), leg('RW07R')]
            })
          ]
        }),
        '2026-09-08T12:00:00.000Z'
      )

      // No transition given — only the (deduped, but nothing to dedupe against) final segment.
      expect(listCachedProcedureLegs(db, 'VHHH', 'approach', 'RNAV Z 07R').map((l) => l.fixIdent)).toEqual(['VH720', 'RW07R'])

      // Transition given — transition legs first, then the final segment with the repeated
      // boundary fix (VH720) dropped, not duplicated.
      expect(listCachedProcedureLegs(db, 'VHHH', 'approach', 'RNAV Z 07R', undefined, 'LIMES').map((l) => l.fixIdent)).toEqual([
        'LIMES',
        'VH720',
        'RW07R'
      ])
    }
  )

  it('keeps a different airport untouched by a replace', () => {
    replaceAirportNavdata(db, 'EGLL', fetched(), '2026-09-08T12:00:00.000Z')
    replaceAirportNavdata(db, 'VHHH', fetched({ icao: 'VHHH' }), '2026-09-08T12:00:00.000Z')

    expect(listCachedRunways(db, 'EGLL')).toHaveLength(2)
    expect(listCachedRunways(db, 'VHHH')).toHaveLength(2)
  })
})
