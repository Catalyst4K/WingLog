import type { NavdataRunway } from '../navdata/navdata-provider'

/** Beyond the painted width, how far off the centreline still counts as on the runway: a
 *  takeoff roll can start off-centre, and the threshold position is derived, not surveyed. */
const CROSS_MARGIN_M = 20
/** Before the threshold (a displaced threshold, the blast pad) or past the far end. */
const ALONG_MARGIN_M = 100
/** Further than this from every runway end, the cached runways aren't this airport's (a
 *  departure from somewhere other than planned): unknown, not "off the runway". */
const MAX_AIRPORT_DISTANCE_M = 8_000

const METRES_PER_DEGREE = 111_320

/**
 * Whether a point is on one of an airport's runways, from the cached navdata
 * (`navdata_runway`): within half the width plus CROSS_MARGIN_M of a centreline, and between
 * its thresholds plus ALONG_MARGIN_M. Null when it can't tell: no runways cached, or the
 * point is nowhere near them.
 *
 * Why (flightdeck-backend's docs/plans/v1-4.md): on flight 230, 2026-10-05, a 35 kt taxi
 * along VHHH's parallel taxiway, 291 m off runway 25L's centreline, was taken for the takeoff
 * roll. The real roll was 0–8 m off.
 */
export function isOnRunway(runways: NavdataRunway[], lat: number, lon: number): boolean | null {
  if (runways.length === 0) return null
  const cosLat = Math.cos((lat * Math.PI) / 180)
  let nearAirport = false
  for (const runway of runways) {
    // Metres east/north of this end's threshold.
    const east = (lon - runway.thresholdLon) * METRES_PER_DEGREE * cosLat
    const north = (lat - runway.thresholdLat) * METRES_PER_DEGREE
    if (Math.hypot(east, north) <= MAX_AIRPORT_DISTANCE_M) nearAirport = true
    const heading = (runway.headingTrueDeg * Math.PI) / 180
    const along = east * Math.sin(heading) + north * Math.cos(heading)
    const cross = east * Math.cos(heading) - north * Math.sin(heading)
    if (along >= -ALONG_MARGIN_M && along <= runway.lengthM + ALONG_MARGIN_M && Math.abs(cross) <= runway.widthM / 2 + CROSS_MARGIN_M) {
      return true
    }
  }
  return nearAirport ? false : null
}
