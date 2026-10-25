/**
 * The sim's own aircraft as a screen draws them (winglog-backend docs/plans/vatsim-build.md, Step 4b): BeyondATC's traffic on its liveries,
 * and any other AI traffic, read from SimConnect. Pure: the records in, the aircraft out.
 */
import { greatCircleM } from '@shared/geo'
import type { TrafficAircraft } from '@shared/ipc'
import type { SimTrafficRecord } from '../sim/simvars'
import { TRAFFIC_MAX_AIRCRAFT } from './feed-snapshot'

/** The longest callsign kept; the sim's own text is cut, not trusted. */
const MAX_CALLSIGN = 12

/** ApronLife's jetways and other scenery objects are listed as aircraft; they are not traffic (Callum, 2026-10-24). */
const SCENERY_TITLE = /^apronlife_/i

/**
 * @param record One aircraft as the sim lists it.
 * @returns True when every number that is drawn is a real number.
 */
function hasPosition(record: SimTrafficRecord): boolean {
  return (
    Number.isFinite(record.latitude) &&
    Number.isFinite(record.longitude) &&
    Math.abs(record.latitude) <= 90 &&
    Math.abs(record.longitude) <= 180
  )
}

/**
 * @param records Every aircraft one sweep listed, the user's own among them.
 * @param userObjectId The sim's object id for the user's aircraft, or null while it is not known.
 * @returns The other aircraft, scenery left out, nearest the user first and at most {@link TRAFFIC_MAX_AIRCRAFT}, each with `ageS` 0 and the
 *   object id as its key (stable across sweeps).
 */
export function simTrafficAircraft(
  records: SimTrafficRecord[],
  userObjectId: number | null
): TrafficAircraft[] {
  const user = records.find((r) => r.objectId === userObjectId)
  const others = records.filter(
    (r) => r.objectId !== userObjectId && !SCENERY_TITLE.test(r.title) && hasPosition(r)
  )
  const distanceOf = (r: SimTrafficRecord): number =>
    user
      ? greatCircleM({ lat: user.latitude, lon: user.longitude }, { lat: r.latitude, lon: r.longitude })
      : 0
  return others
    .map((record) => ({ record, distance: distanceOf(record) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, TRAFFIC_MAX_AIRCRAFT)
    .map(({ record }) => ({
      key: String(record.objectId),
      callsign: record.atcId.trim().slice(0, MAX_CALLSIGN),
      latitude: record.latitude,
      longitude: record.longitude,
      altitudeM: record.altitudeM,
      groundSpeedMs: record.groundSpeedMs,
      headingDeg: record.headingDeg,
      onGround: record.onGround,
      aircraftIcao: null,
      departure: null,
      arrival: null,
      ageS: 0
    }))
}
