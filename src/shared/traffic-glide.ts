/**
 * Where a network aircraft is drawn between two refreshes: along its heading at its ground speed, from the position the feed gave.
 * Pure, and shared so the PC and the phone move aircraft identically.
 */
import { destinationPoint, type LatLon } from './geo'
import type { TrafficAircraft } from './types/online'

/** The longest an aircraft is moved on from its reported position, seconds. Past this the feed is stale, and a straight line would drift. */
export const MAX_GLIDE_S = 30

/**
 * @param aircraft One aircraft, as published.
 * @param secondsSinceReceived Seconds since this screen received the payload, counted on this screen's own clock (the phone's clock is
 *   not the PC's).
 * @returns Where to draw it. An aircraft on the ground is drawn where it was reported.
 */
export function glidePosition(
  aircraft: Pick<
    TrafficAircraft,
    'latitude' | 'longitude' | 'headingDeg' | 'groundSpeedMs' | 'onGround' | 'ageS'
  >,
  secondsSinceReceived: number
): LatLon {
  const at = { lat: aircraft.latitude, lon: aircraft.longitude }
  if (aircraft.onGround) return at
  const seconds = Math.min(Math.max(0, aircraft.ageS + secondsSinceReceived), MAX_GLIDE_S)
  return seconds === 0 ? at : destinationPoint(at, aircraft.headingDeg, aircraft.groundSpeedMs * seconds)
}
