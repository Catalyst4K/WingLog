/** Which runway a landing is read against, once it has been stored: the same source it was measured against. */

import { findRunwayEndByIdent, runwayEndsFromNavdata, type RunwayEnd } from '../airports/runway-lookup'
import type { WingLogDb } from './client'
import { listCachedRunways } from './navdata-repo'

/**
 * A stored landing's runway, from the source it was measured against, so the score and the touchdown diagram judge the same runway
 * the offset was measured to. A landing from before the source was stored, or one whose sim runway is no longer cached, reads the
 * airport database, as it always did.
 *
 * @param db The database.
 * @param landing The landing's runway ident and source.
 * @param icao The airport it was at.
 * @returns The runway end, or null when it has no runway or none is known.
 */
export function runwayEndForLanding(
  db: WingLogDb,
  landing: { runwayIdent: string | null; runwaySource: 'database' | 'sim' | null },
  icao: string
): RunwayEnd | null {
  if (!landing.runwayIdent) return null
  if (landing.runwaySource === 'sim') {
    const fromSim = runwayEndsFromNavdata(icao, listCachedRunways(db, icao)).find(
      (end) => end.ident === landing.runwayIdent
    )
    if (fromSim) return fromSim
  }
  return findRunwayEndByIdent(icao, landing.runwayIdent)
}
