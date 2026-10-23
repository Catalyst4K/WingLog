/**
 * The airports the generated taxi clearances are made on: every airport whose taxi network WingLog has cached, with its runways and stands
 * (winglog-backend docs/plans/taxi-and-second-screen-robustness.md, stage 6a). These are the networks the app traces on. BeyondATC's saved
 * copies (the network as flown) can be added when WingLog fetches the network as flown (stage 2b of the plan); until then the two can differ.
 * Read-only: nothing here writes to the database, and the data stays local.
 */
import type { WingLogDb } from '../../src/main/db/client'
import { listCachedRunways, listCachedStands, listCachedTaxiSegments } from '../../src/main/db/navdata-repo'
import { navdataTaxiSegment } from '../../src/main/db/schema'
import type { GeneratorAirport } from './taxi-generate'

/**
 * @param db WingLog's database, opened read-only.
 * @param only The airports to use (their codes), or undefined for every cached one.
 * @returns Each airport with a cached taxi network, largest first so a slow one starts early.
 */
export function loadGeneratorAirports(db: WingLogDb, only?: string[]): GeneratorAirport[] {
  const icaos = [
    ...new Set(
      db
        .select({ icao: navdataTaxiSegment.icao })
        .from(navdataTaxiSegment)
        .all()
        .map((r) => r.icao)
    )
  ]
  return icaos
    .filter((icao) => !only || only.includes(icao))
    .map((icao) => ({
      icao,
      segments: listCachedTaxiSegments(db, icao),
      runways: listCachedRunways(db, icao),
      stands: listCachedStands(db, icao)
    }))
    .filter((airport) => airport.segments.length > 0)
    .sort((a, b) => b.segments.length - a.segments.length)
}
