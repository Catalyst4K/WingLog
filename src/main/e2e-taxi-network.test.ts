import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createDb } from './db/client'
import { listCachedTaxiSegments } from './db/navdata-repo'
import { E2E_TAXI_ICAO_ENV, E2E_TAXI_NETWORK_ENV, seedE2eTaxiNetwork } from './e2e-taxi-network'

function freshDb() {
  const { db } = createDb(':memory:')
  migrate(db, { migrationsFolder: 'drizzle' })
  return db
}

/** A file of rows and the environment that names it. */
function network(rows: unknown, icao = 'ZJSY'): NodeJS.ProcessEnv {
  const file = join(mkdtempSync(join(tmpdir(), 'winglog-taxi-')), 'network.json')
  writeFileSync(file, JSON.stringify(rows))
  return { [E2E_TAXI_NETWORK_ENV]: file, [E2E_TAXI_ICAO_ENV]: icao }
}

const ROWS = [
  [18.3, 109.4, 18.301, 109.401, 'D', 0, 0],
  [18.301, 109.401, 18.302, 109.402, null, 0, 1]
]

describe('seedE2eTaxiNetwork', () => {
  it('stores the rows of the file for the airport named, as the sim would have fetched them', () => {
    const db = freshDb()
    expect(seedE2eTaxiNetwork(db, false, network(ROWS))).toBe(2)
    expect(listCachedTaxiSegments(db, 'ZJSY')).toEqual([
      {
        startLat: 18.3,
        startLon: 109.4,
        endLat: 18.301,
        endLon: 109.401,
        name: 'D',
        startHoldShort: false,
        endHoldShort: false
      },
      {
        startLat: 18.301,
        startLon: 109.401,
        endLat: 18.302,
        endLon: 109.402,
        name: null,
        startHoldShort: false,
        endHoldShort: true
      }
    ])
  })

  it('does nothing in a packaged build, or when either variable is missing', () => {
    const db = freshDb()
    expect(seedE2eTaxiNetwork(db, true, network(ROWS))).toBe(0)
    expect(seedE2eTaxiNetwork(db, false, {})).toBe(0)
    expect(seedE2eTaxiNetwork(db, false, { [E2E_TAXI_ICAO_ENV]: 'ZJSY' })).toBe(0)
    expect(listCachedTaxiSegments(db, 'ZJSY')).toEqual([])
  })

  it('refuses an airport code that is not one, and a file that is not a list of rows', () => {
    const db = freshDb()
    expect(() => seedE2eTaxiNetwork(db, false, network(ROWS, '../etc'))).toThrow('not an airport code')
    expect(() => seedE2eTaxiNetwork(db, false, network({ rows: [] }))).toThrow('not a list of rows')
  })
})
