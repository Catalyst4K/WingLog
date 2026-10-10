/**
 * Whether a position is on one of the departure airport's runways, from the cached navdata: what
 * keeps a fast taxi on a parallel taxiway from counting as the takeoff roll (FlightRecorder).
 */
import type { NavdataRunway } from '@shared/ipc'
import { flatDistanceM } from '@shared/geo'
import { positionRelativeToRunway } from '../airports/landing-maths'

/** Beyond the painted width, how far off the centreline still counts as on the runway: a
 *  takeoff roll can start off-centre, and the threshold position is derived, not surveyed. */
const CROSS_MARGIN_M = 20
/** Before the threshold (a displaced threshold, the blast pad) or past the far end. */
const ALONG_MARGIN_M = 100
/** Further than this from every runway end, the cached runways aren't this airport's (a
 *  departure from somewhere other than planned): unknown, not "off the runway". */
const MAX_AIRPORT_DISTANCE_M = 8_000

/**
 * Whether a point is on one of an airport's runways, from the cached navdata
 * (`navdata_runway`): within half the width plus CROSS_MARGIN_M of a centreline, and between
 * its thresholds plus ALONG_MARGIN_M. Null when it can't tell: no runways cached, or the
 * point is nowhere near them.
 *
 * Why (winglog-backend's docs/plans/v1-4.md): a fast taxi along a parallel taxiway was once
 * taken for the takeoff roll; a real roll is within a few metres of the centreline.
 *
 * @param runways The airport's cached runways.
 * @param lat Degrees.
 * @param lon Degrees.
 * @returns True on a runway, false off them, null when it can't tell.
 */
export function isOnRunway(runways: NavdataRunway[], lat: number, lon: number): boolean | null {
  if (runways.length === 0) return null
  let nearAirport = false
  for (const runway of runways) {
    const threshold = { lat: runway.thresholdLat, lon: runway.thresholdLon }
    if (flatDistanceM(threshold, { lat, lon }) <= MAX_AIRPORT_DISTANCE_M) nearAirport = true
    const { distanceFromThresholdM: along, centrelineOffsetM: cross } = positionRelativeToRunway(
      lat,
      lon,
      runway.thresholdLat,
      runway.thresholdLon,
      runway.headingTrueDeg
    )
    if (
      along >= -ALONG_MARGIN_M &&
      along <= runway.lengthM + ALONG_MARGIN_M &&
      Math.abs(cross) <= runway.widthM / 2 + CROSS_MARGIN_M
    ) {
      return true
    }
  }
  return nearAirport ? false : null
}
