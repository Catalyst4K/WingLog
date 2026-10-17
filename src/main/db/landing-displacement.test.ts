import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import { createDb, type WingLogDb } from './client'
import { createAircraft } from './aircraft-repo'
import { createFlight } from './flight-repo'
import { correctLandingsForDisplacedThresholds } from './landing-displacement'
import { createLanding, listLandingsByFlight, type NewLanding } from './landing-repo'
import { landing, navdataRunway } from './schema'

// Bergen 17 as the sim has it (2026-10-17): the whole strip, with the displaced threshold the sim states, 270 m. Flight 242 touched
// down 730 m from the pavement end, 3.5 m left of the centreline, and was stored as 730.
const ENBR_17 = {
  ident: '17',
  headingTrueDeg: 170.56,
  lengthM: 2982.91,
  widthM: 45.24,
  surface: 4,
  thresholdLat: 60.306639864245795,
  thresholdLon: 5.21371178198079,
  displacedThresholdM: 270
}
// Singapore 20R: the sim runway already starts at the usable threshold, so it reports none.
const WSSS_20R = {
  ident: '20R',
  headingTrueDeg: 203,
  lengthM: 3221.2,
  widthM: 60,
  surface: 4,
  thresholdLat: 1.3757575921283205,
  thresholdLon: 103.98878019536174,
  displacedThresholdM: 0
}

function landingAt(flightId: number, overrides: Partial<NewLanding>): NewLanding {
  return {
    flightId,
    seq: 1,
    icao: 'ENBR',
    touchdownTsUtc: '2026-10-17T13:06:56.018Z',
    verticalSpeedMs: -2.16,
    gForce: 1.3,
    pitchDeg: 4.8,
    bankDeg: 0.1,
    headingTrueDeg: 170.5,
    indicatedAirspeedMs: 67,
    groundSpeedMs: 66,
    windSpeedMs: 0,
    windDirectionDeg: 0,
    headwindMs: 0,
    crosswindMs: 0,
    crabDeg: 0,
    runwayIdent: '17',
    distanceFromThresholdM: 730.27,
    centrelineOffsetM: -3.55,
    flapSetting: 5,
    touchdownSource: 'derived',
    runwaySource: 'sim',
    ...overrides
  }
}

describe('correctLandingsForDisplacedThresholds', () => {
  let db: WingLogDb
  let flightId: number

  beforeEach(() => {
    const created = createDb(':memory:')
    migrate(created.db, { migrationsFolder: 'drizzle' })
    db = created.db
    const aircraftId = createAircraft(db, { registration: 'G-ABCD', icaoType: 'A320' }).id
    flightId = createFlight(db, { aircraftId, depIcao: 'EGCC', arrIcao: 'ENBR' }).id
    for (const [icao, runway] of [
      ['ENBR', ENBR_17],
      ['WSSS', WSSS_20R]
    ] as const) {
      db.insert(navdataRunway)
        .values({ icao, source: 'sim-facility', fetchedAt: '2026-10-17T12:35:06.429Z', ...runway })
        .run()
    }
  })

  const distances = (): (number | null)[] =>
    listLandingsByFlight(db, flightId).map((l) => l.distanceFromThresholdM)

  it('takes the sim displaced threshold off a landing measured from the pavement end', () => {
    createLanding(db, landingAt(flightId, {}))
    expect(correctLandingsForDisplacedThresholds(db, 'ENBR')).toBe(1)
    expect(distances()[0]).toBeCloseTo(730.27 - 270, 2)
  })

  it('leaves a runway the sim reports no displacement for, a database-measured landing, and other airports alone', () => {
    createLanding(
      db,
      landingAt(flightId, { seq: 1, icao: 'WSSS', runwayIdent: '20R', distanceFromThresholdM: 949 })
    )
    createLanding(db, landingAt(flightId, { seq: 2, runwaySource: 'database' }))
    createLanding(
      db,
      landingAt(flightId, { seq: 3, icao: 'EGLL', runwayIdent: '27L', distanceFromThresholdM: 300 })
    )
    expect(correctLandingsForDisplacedThresholds(db, 'ENBR')).toBe(0)
    expect(correctLandingsForDisplacedThresholds(db, 'WSSS')).toBe(0)
    expect(distances()).toEqual([949, 730.27, 300])
  })

  it('treats a runway whose threshold the sim has not stated as having none, and skips a deleted landing', () => {
    db.update(navdataRunway).set({ displacedThresholdM: null }).where(eq(navdataRunway.icao, 'ENBR')).run()
    createLanding(db, landingAt(flightId, { seq: 1 }))
    expect(correctLandingsForDisplacedThresholds(db, 'ENBR')).toBe(0)
    db.update(navdataRunway).set({ displacedThresholdM: 270 }).where(eq(navdataRunway.icao, 'ENBR')).run()
    db.update(landing)
      .set({ deletedAt: '2026-10-17T14:00:00.000Z' })
      .where(eq(landing.flightId, flightId))
      .run()
    expect(correctLandingsForDisplacedThresholds(db, 'ENBR')).toBe(0)
  })
})
