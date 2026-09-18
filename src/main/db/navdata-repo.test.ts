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
    routeDistanceM: 0,
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

  it('offers a synthetic Visual approach (transition Vectors) for every cached runway end, filtered by runway', () => {
    replaceAirportNavdata(db, 'EGLL', fetched(), '2026-09-18T12:00:00.000Z')

    expect(listCachedProcedures(db, 'EGLL', 'approach', null)).toEqual([
      { identifier: 'Visual 27R', transition: 'Vectors' },
      { identifier: 'Visual 09L', transition: 'Vectors' }
    ])
    expect(listCachedProcedures(db, 'EGLL', 'approach', '09L')).toEqual([{ identifier: 'Visual 09L', transition: 'Vectors' }])
    // Never offered for SIDs/STARs, or for an airport with nothing cached.
    expect(listCachedProcedures(db, 'EGLL', 'star', null)).toEqual([])
    expect(listCachedProcedures(db, 'ZZZZ', 'approach', null)).toEqual([])
  })

  it('builds a Visual approach\'s legs from the runway threshold: join point 10 nm out on the extended centreline, then the threshold', () => {
    replaceAirportNavdata(db, 'EGLL', fetched(), '2026-09-18T12:00:00.000Z')
    const runway = listCachedRunways(db, 'EGLL').find((r) => r.ident === '27R')!

    const legs = listCachedProcedureLegs(db, 'EGLL', 'approach', 'Visual 27R', null, 'Vectors')

    expect(legs.map((l) => l.fixIdent)).toEqual(['27R/10', 'RW27R'])
    expect(legs[1]).toEqual(expect.objectContaining({ fixLatitude: runway.thresholdLat, fixLongitude: runway.thresholdLon, fixType: 'R' }))
    // 27R lands on heading 270, so the join point is due east of the threshold (the
    // aircraft approaches flying west) — ~10 nm = 18,520 m of longitude at this latitude.
    const join = legs[0]!
    expect(join.fixLatitude).toBeCloseTo(runway.thresholdLat, 3)
    const eastM = (join.fixLongitude - runway.thresholdLon) * 111320 * Math.cos((runway.thresholdLat * Math.PI) / 180)
    expect(eastM).toBeCloseTo(18520, -2)
  })

  it('returns no legs for a Visual approach whose runway is not cached', () => {
    replaceAirportNavdata(db, 'EGLL', fetched(), '2026-09-18T12:00:00.000Z')
    expect(listCachedProcedureLegs(db, 'EGLL', 'approach', 'Visual 99X')).toEqual([])
  })

  it("round-trips an FC leg's distance so the transition's LAM/11 endpoint can be placed", () => {
    replaceAirportNavdata(
      db,
      'EGLL',
      fetched({
        icao: 'EGLL',
        approaches: [
          approach({
            identifier: 'ILS 27R',
            runwayIdent: '27R',
            transitions: [
              { name: 'LAM', legs: [leg('LAM', { type: 9, fixType: 'V', courseDeg: 272, routeDistanceM: 20372 }), leg('D125O', { type: 7 })] }
            ],
            finalLegs: [leg('CF27R')]
          })
        ]
      }),
      '2026-09-18T12:00:00.000Z'
    )

    const legs = listCachedProcedureLegs(db, 'EGLL', 'approach', 'ILS 27R', null, 'LAM')
    expect(legs.map((l) => [l.fixIdent, l.type, l.routeDistanceM])).toEqual([
      ['LAM', 9, 20372],
      ['D125O', 7, 0],
      ['CF27R', 4, 0]
    ])
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

    // Visual approaches (docs/plans/visual-approach.md) are synthesised on top of the real ones.
    expect(listCachedProcedures(db, 'VHHH', 'approach', null).filter((p) => !p.identifier.startsWith('Visual '))).toEqual([
      { identifier: 'RNAV Z 07R', transition: 'LIMES' }
    ])
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

  it('assembles a STAR as enroute-transition legs, then common legs, then runway-transition legs (reverse of a SID)', () => {
    replaceAirportNavdata(
      db,
      'YBBN',
      fetched({
        icao: 'YBBN',
        departures: [],
        arrivals: [
          procedure({
            name: 'MIXED2A',
            enrouteTransitions: [{ name: 'ENTRANS', legs: [leg('ENRFIX')] }],
            commonLegs: [leg('COMMON')],
            runwayTransitions: [{ runwayIdent: '19L', legs: [leg('RWYFIX')] }]
          })
        ]
      }),
      '2026-09-11T08:00:00.000Z'
    )

    // No runway/transition given — only the common legs.
    expect(listCachedProcedureLegs(db, 'YBBN', 'star', 'MIXED2A').map((l) => l.fixIdent)).toEqual(['COMMON'])

    expect(listCachedProcedureLegs(db, 'YBBN', 'star', 'MIXED2A', '19L').map((l) => l.fixIdent)).toEqual([
      'COMMON',
      'RWYFIX'
    ])
    expect(listCachedProcedureLegs(db, 'YBBN', 'star', 'MIXED2A', '19L', 'ENTRANS').map((l) => l.fixIdent)).toEqual([
      'ENRFIX',
      'COMMON',
      'RWYFIX'
    ])
  })

  it(
    'reproduces the real YBBN SMOK2A shape: a STAR with a non-empty common route sharing its ' +
      'boundary fix with the runway transition — assembled correctly and deduped, not the ' +
      "departure order that drew spurious lines back across the arrival",
    () => {
      replaceAirportNavdata(
        db,
        'YBBN',
        fetched({
          icao: 'YBBN',
          departures: [],
          arrivals: [
            procedure({
              name: 'SMOK2A',
              // GARTH is both the common route's last leg and the runway transition's first
              // leg — the real ARINC 424 shape found live 2026-09-11 (docs/navdata-notes.md).
              commonLegs: [leg('SMOKA'), leg('OTGAT'), leg('GARTH')],
              runwayTransitions: [
                { runwayIdent: '19L', legs: [leg('GARTH'), leg('BURPA'), leg('IGBON'), leg('EMSIT'), leg('IRVUL'), leg('BETSO')] }
              ]
            })
          ]
        }),
        '2026-09-11T08:00:00.000Z'
      )

      const legs = listCachedProcedureLegs(db, 'YBBN', 'star', 'SMOK2A', '19L').map((l) => l.fixIdent)
      expect(legs).toEqual(['SMOKA', 'OTGAT', 'GARTH', 'BURPA', 'IGBON', 'EMSIT', 'IRVUL', 'BETSO'])
      // GARTH appears exactly once, not duplicated across the common/runway boundary.
      expect(legs.filter((f) => f === 'GARTH')).toHaveLength(1)
    }
  )

  it('keeps a different airport untouched by a replace', () => {
    replaceAirportNavdata(db, 'EGLL', fetched(), '2026-09-08T12:00:00.000Z')
    replaceAirportNavdata(db, 'VHHH', fetched({ icao: 'VHHH' }), '2026-09-08T12:00:00.000Z')

    expect(listCachedRunways(db, 'EGLL')).toHaveLength(2)
    expect(listCachedRunways(db, 'VHHH')).toHaveLength(2)
  })
})
