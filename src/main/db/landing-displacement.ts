/**
 * One-time correction of landings stored before a sim runway's displaced threshold was applied: their distance was measured from the
 * runway's physical end, where the landing threshold is further along (Bergen 17: 730 m from the end was 460 m past the threshold).
 * Runs once per database, marked in `app_setting`, so a landing captured afterwards (already measured from the usable threshold)
 * is never corrected twice.
 */

import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import { runwayEndsFromNavdata } from '../airports/runway-lookup'
import type { WingLogDb } from './client'
import { listCachedRunways } from './navdata-repo'
import { landing } from './schema'
import { getSetting, setSetting } from './settings-repo'

const DONE_KEY = 'landing_displacement_corrected'

/**
 * Takes the displaced threshold off the stored distance of each landing measured against a sim runway that has one. A landing whose
 * airport's runways are not cached, or whose runway has no displacement, is left as it is.
 *
 * @param db The database.
 * @returns How many landings were corrected, or null when it had already run.
 */
export function correctLandingDisplacements(db: WingLogDb): number | null {
  if (getSetting(db, DONE_KEY) === 'done') return null
  const rows = db
    .select()
    .from(landing)
    .where(
      and(
        eq(landing.runwaySource, 'sim'),
        isNull(landing.deletedAt),
        isNotNull(landing.distanceFromThresholdM),
        isNotNull(landing.runwayIdent),
        isNotNull(landing.icao)
      )
    )
    .all()
  let corrected = 0
  for (const row of rows) {
    if (row.icao === null || row.distanceFromThresholdM === null) continue
    const end = runwayEndsFromNavdata(row.icao, listCachedRunways(db, row.icao)).find(
      (e) => e.ident === row.runwayIdent
    )
    if (!end || end.displacedThresholdM <= 0) continue
    db.update(landing)
      .set({
        distanceFromThresholdM: row.distanceFromThresholdM - end.displacedThresholdM,
        updatedAt: new Date().toISOString()
      })
      .where(eq(landing.id, row.id))
      .run()
    corrected++
  }
  setSetting(db, DONE_KEY, 'done')
  return corrected
}
