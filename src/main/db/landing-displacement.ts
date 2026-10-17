/**
 * Landings stored before the sim's displaced thresholds were read were measured from the runway's pavement end, where the landing
 * threshold is further along (Bergen 17: 730 m from the end was 460 m past the threshold). When an airport's runways are fetched again and
 * now carry the sim's own displaced threshold lengths, those landings are corrected once.
 */

import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import type { WingLogDb } from './client'
import { listCachedRunways } from './navdata-repo'
import { landing } from './schema'

/**
 * Takes the displaced threshold off the stored distance of each landing at this airport that was measured against a sim runway. Run once,
 * when the airport's runways first arrive with their displaced thresholds (`SimFacilitiesProvider.refreshAirport`): a landing captured
 * after that was measured from the threshold already, and is never in the set this run sees.
 *
 * @param db The database.
 * @param icao The airport whose runways were just fetched.
 * @returns How many landings were corrected.
 */
export function correctLandingsForDisplacedThresholds(db: WingLogDb, icao: string): number {
  const displacedByIdent = new Map(
    listCachedRunways(db, icao).map((runway) => [runway.ident, runway.displacedThresholdM ?? 0])
  )
  const rows = db
    .select()
    .from(landing)
    .where(
      and(
        eq(landing.icao, icao),
        eq(landing.runwaySource, 'sim'),
        isNull(landing.deletedAt),
        isNotNull(landing.distanceFromThresholdM),
        isNotNull(landing.runwayIdent)
      )
    )
    .all()
  let corrected = 0
  for (const row of rows) {
    const displaced = displacedByIdent.get(row.runwayIdent ?? '') ?? 0
    if (displaced <= 0 || row.distanceFromThresholdM === null) continue
    db.update(landing)
      .set({
        distanceFromThresholdM: row.distanceFromThresholdM - displaced,
        updatedAt: new Date().toISOString()
      })
      .where(eq(landing.id, row.id))
      .run()
    corrected++
  }
  return corrected
}
