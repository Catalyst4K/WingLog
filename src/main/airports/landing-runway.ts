/** The runway a touchdown is measured against while it is being captured: the sim's own, then the airport database's. */

import type { NavdataRunway } from '@shared/ipc'
import { findRunwayEnd, resolveRunwayEnd, runwayEndsFromNavdata, type RunwayEnd } from './runway-lookup'

/**
 * The resolver for a touchdown being captured: the sim's own runway first, since that is where the aircraft actually was (MSFS's
 * scenery can sit tens of metres from the airport database's: WSSS 20R is 40 m off), then the vendored database for airports the sim
 * hasn't cached or whose cached runways don't fit the touchdown.
 *
 * @param simRunways The airport's runways cached from the sim, empty when none are.
 * @returns A resolver for `buildLandingRecord`.
 */
export function landingRunwayResolver(
  simRunways: NavdataRunway[]
): (icao: string, headingDeg: number, lat: number, lon: number) => RunwayEnd | null {
  return (icao, headingDeg, lat, lon) =>
    resolveRunwayEnd(runwayEndsFromNavdata(icao, simRunways), icao, headingDeg, lat, lon) ??
    findRunwayEnd(icao, headingDeg, lat, lon)
}
