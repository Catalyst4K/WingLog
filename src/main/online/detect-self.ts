/**
 * Finds the pilot's own aircraft in a network feed: pure, so it is tested against recorded feeds with a pilot injected.
 *
 * The sim never says whether the pilot is online (the network client is a separate program), so the feed is the only source.
 * By member number it is exact. Without one, a pilot whose filed departure and arrival match the flight and who is within a few
 * miles of the aircraft is "probably" it. It never matches on a callsign alone, since another pilot can use the same one.
 * Plan: winglog-backend docs/plans/vatsim-build.md, Step 2.
 */
import { greatCircleNm, type LatLon } from '@shared/geo'
import type { OnlineStatus } from '@shared/ipc'
import type { FeedPilot, FeedSnapshot } from './feed-snapshot'

/** How close a pilot with a matching plan must be to the aircraft to be taken as it, nautical miles. */
export const PROBABLY_RADIUS_NM = 5

/** What is known of the pilot and their flight. */
export interface SelfQuery {
  /** The pilot's CID or VID, or null when none was entered. */
  memberId: string | null
  /** The flight being tracked: its filed departure and arrival. */
  flight: { departure: string; arrival: string } | null
  /** Where the aircraft is, or null when unknown. */
  position: LatLon | null
  /** Dev build only: take the pilot with this callsign to be the pilot. */
  pretendCallsign: string | null
}

/** The result: the status the topic carries, and the pilot found (main only, never published). */
export interface SelfMatch {
  status: Pick<OnlineStatus, 'state' | 'callsign' | 'filedPlan'>
  pilot: FeedPilot | null
}

const OFFLINE: SelfMatch = { status: { state: 'offline', callsign: null, filedPlan: null }, pilot: null }

/**
 * @param pilot The pilot found.
 * @param state How sure it is.
 * @returns The match for it.
 */
function found(pilot: FeedPilot, state: 'online' | 'probably'): SelfMatch {
  const hasPlan = pilot.departure !== null || pilot.arrival !== null || pilot.aircraftIcao !== null
  return {
    status: {
      state,
      callsign: pilot.callsign,
      filedPlan: hasPlan
        ? { departure: pilot.departure, arrival: pilot.arrival, aircraftIcao: pilot.aircraftIcao }
        : null
    },
    pilot
  }
}

/**
 * Looks for the pilot's own aircraft in a feed.
 *
 * @param snapshot The parsed feed.
 * @param query The member number, the flight, the aircraft's position and the dev override.
 * @returns Online (by member number or the dev override), probably (by the plan and position), or offline.
 */
export function detectSelf(snapshot: FeedSnapshot, query: SelfQuery): SelfMatch {
  if (query.pretendCallsign) {
    const pretended = snapshot.pilots.find((pilot) => pilot.callsign === query.pretendCallsign)
    return pretended ? found(pretended, 'online') : OFFLINE
  }
  if (query.memberId !== null) {
    const own = snapshot.pilots.find((pilot) => pilot.memberId === query.memberId)
    return own ? found(own, 'online') : OFFLINE
  }
  const { flight, position } = query
  if (!flight || !position) return OFFLINE
  const near = snapshot.pilots
    .filter((pilot) => pilot.departure === flight.departure && pilot.arrival === flight.arrival)
    .map((pilot) => ({
      pilot,
      nm: greatCircleNm(position, { lat: pilot.latitude, lon: pilot.longitude })
    }))
    .filter(({ nm }) => nm <= PROBABLY_RADIUS_NM)
    .sort((a, b) => a.nm - b.nm)[0]
  return near ? found(near.pilot, 'probably') : OFFLINE
}
