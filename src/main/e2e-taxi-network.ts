/**
 * A taxi network for an acceptance test: the isolated test database has none, and the sim that would fetch it isn't there. An unpackaged
 * build reads the rows of one airport's network from the JSON file WINGLOG_E2E_TAXI_NETWORK names, as the taxi code's own fixtures hold them,
 * and stores them for the airport WINGLOG_E2E_TAXI_ICAO names. A packaged build ignores both.
 */
import { readFileSync } from 'node:fs'
import type { WingLogDb } from './db/client'
import { replaceAirportTaxiSegments } from './db/navdata-repo'

export const E2E_TAXI_NETWORK_ENV = 'WINGLOG_E2E_TAXI_NETWORK'
export const E2E_TAXI_ICAO_ENV = 'WINGLOG_E2E_TAXI_ICAO'

/** One row of the fixture: start lat, start lon, end lat, end lon, name, start hold short, end hold short. */
type Row = [number, number, number, number, string | null, number, number]

/**
 * @param db The database.
 * @param packaged Whether this is a packaged build.
 * @param env The environment.
 * @returns How many segments were stored, 0 when nothing is asked for.
 * @throws When the airport code is not 3 or 4 letters or digits, or the file is not a list of rows.
 */
export function seedE2eTaxiNetwork(
  db: WingLogDb,
  packaged: boolean,
  env: NodeJS.ProcessEnv = process.env
): number {
  const path = env[E2E_TAXI_NETWORK_ENV]
  const icao = env[E2E_TAXI_ICAO_ENV]
  if (packaged || !path || !icao) return 0
  if (!/^[A-Z0-9]{3,4}$/.test(icao)) throw new Error(`${E2E_TAXI_ICAO_ENV} is not an airport code`)
  const rows: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(rows)) throw new Error(`${E2E_TAXI_NETWORK_ENV} is not a list of rows`)
  const segments = (rows as Row[]).map(
    ([startLat, startLon, endLat, endLon, name, startHoldShort, endHoldShort]) => ({
      startLat,
      startLon,
      endLat,
      endLon,
      name,
      startHoldShort: startHoldShort === 1,
      endHoldShort: endHoldShort === 1
    })
  )
  replaceAirportTaxiSegments(db, icao, { icao, segments }, new Date().toISOString())
  return segments.length
}
