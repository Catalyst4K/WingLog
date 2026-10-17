import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import { createDb, type WingLogDb } from './client'
import { createAircraft } from './aircraft-repo'
import { createFlight } from './flight-repo'
import { correctLandingDisplacements } from './landing-displacement'
import { createLanding, listLandingsByFlight, type NewLanding } from './landing-repo'
import { landing, navdataRunway } from './schema'
import { getSetting } from './settings-repo'

// Bergen 17 as the sim has it (fetched 2026-10-17): the whole 2,983 m strip, its end 5 m from OurAirports', which lists the 270 m
// displaced threshold. Flight 242 touched down 730 m from that end, 3.5 m left of the centreline, and was stored as 730.
const ENBR_17 = {
  ident: '17',
  headingTrueDeg: 170.5601806640625,
  lengthM: 2982.910400390625,
  widthM: 45.24243927001953,
  surface: 4,
  thresholdLat: 60.306639864245795,
  thresholdLon: 5.21371178198079
}
// Singapore 20R as the sim has it (flight 236): the usable threshold already, 822 m from OurAirports' physical end.
const WSSS_20R = {
  ident: '20R',
  headingTrueDeg: 203,
  lengthM: 3221.2,
  widthM: 60,
  surface: 4,
  thresholdLat: 1.3757575921283205,
  thresholdLon: 103.98878019536174
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

describe('correctLandingDisplacements', () => {
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

  it("takes Bergen 17's 270 m displaced threshold off a landing measured from the pavement end, once", () => {
    createLanding(db, landingAt(flightId, {}))
    expect(correctLandingDisplacements(db)).toBe(1)
    const [row] = listLandingsByFlight(db, flightId)
    expect(row?.distanceFromThresholdM).toBeCloseTo(730.27 - 270, 0)
    // A second launch changes nothing, so a landing is never corrected twice.
    expect(correctLandingDisplacements(db)).toBeNull()
    expect(listLandingsByFlight(db, flightId)[0]?.distanceFromThresholdM).toBe(row?.distanceFromThresholdM)
    expect(getSetting(db, 'landing_displacement_corrected')).toBe('done')
  })

  it('leaves a sim runway that already leaves its displaced part out, one from the database, and one with no runway cached', () => {
    createLanding(
      db,
      landingAt(flightId, { seq: 1, icao: 'WSSS', runwayIdent: '20R', distanceFromThresholdM: 949 })
    )
    createLanding(db, landingAt(flightId, { seq: 2, runwaySource: 'database' }))
    createLanding(
      db,
      landingAt(flightId, { seq: 3, icao: 'EGLL', runwayIdent: '27L', distanceFromThresholdM: 300 })
    )
    expect(correctLandingDisplacements(db)).toBe(0)
    expect(listLandingsByFlight(db, flightId).map((l) => l.distanceFromThresholdM)).toEqual([
      949, 730.27, 300
    ])
  })

  it('skips a deleted landing', () => {
    createLanding(db, landingAt(flightId, {}))
    db.update(landing)
      .set({ deletedAt: '2026-10-17T14:00:00.000Z' })
      .where(eq(landing.flightId, flightId))
      .run()
    expect(correctLandingDisplacements(db)).toBe(0)
  })
})
