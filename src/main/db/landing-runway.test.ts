import { describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { NavdataRunway } from '@shared/ipc'
import { createDb } from './client'
import { runwayEndForLanding } from './landing-runway'
import { navdataRunway } from './schema'

// WSSS 20R from the sim's own facility data (flight 236, 2026-10-12), and where the A380 touched down on it: 949 m past the sim's
// threshold, 1.9 m left of its centreline. OurAirports' 20R is the same strip 40 m to the east, with a 740 m displaced threshold.
const SIM_20R: NavdataRunway = {
  ident: '20R',
  headingTrueDeg: 203,
  lengthM: 3221.2,
  widthM: 60,
  surface: 4,
  thresholdLat: 1.3757575921283205,
  thresholdLon: 103.98878019536174
}
describe('runwayEndForLanding', () => {
  const { db } = createDb(':memory:')
  migrate(db, { migrationsFolder: 'drizzle' })
  db.insert(navdataRunway)
    .values({
      icao: 'WSSS',
      source: 'sim-facility',
      fetchedAt: '2026-10-12T10:19:46.706Z',
      ident: SIM_20R.ident,
      headingTrueDeg: SIM_20R.headingTrueDeg,
      lengthM: SIM_20R.lengthM,
      widthM: SIM_20R.widthM,
      surface: SIM_20R.surface,
      thresholdLat: SIM_20R.thresholdLat,
      thresholdLon: SIM_20R.thresholdLon
    })
    .run()

  it("reads a landing measured against the sim from the sim's cached runway", () => {
    const end = runwayEndForLanding(db, { runwayIdent: '20R', runwaySource: 'sim' }, 'WSSS')
    expect(end?.source).toBe('sim')
    expect(end?.lengthM).toBeCloseTo(3221.2, 1)
  })

  it('reads a landing with no source, or a database one, from the airport database', () => {
    expect(runwayEndForLanding(db, { runwayIdent: '20R', runwaySource: null }, 'WSSS')?.source).toBe(
      'database'
    )
    expect(runwayEndForLanding(db, { runwayIdent: '20R', runwaySource: 'database' }, 'WSSS')?.source).toBe(
      'database'
    )
  })

  it('falls back to the database when the sim runway is no longer cached, and finds nothing with no runway', () => {
    expect(runwayEndForLanding(db, { runwayIdent: '20R', runwaySource: 'sim' }, 'WSSS')?.ident).toBe('20R')
    expect(runwayEndForLanding(db, { runwayIdent: '02L', runwaySource: 'sim' }, 'WSSS')?.source).toBe(
      'database'
    )
    expect(runwayEndForLanding(db, { runwayIdent: null, runwaySource: 'sim' }, 'WSSS')).toBeNull()
  })
})
