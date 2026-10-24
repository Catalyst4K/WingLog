/**
 * The pilot's own online status from the latest feed: pure, so the rules for when it is "unknown", "offline", "online" or "probably" are
 * tested without a service. `NetworkFeedService` calls it after every feed it reads and publishes the result as `onlineStatus`.
 */
import type { LatLon } from '@shared/geo'
import type { OnlineNetwork, OnlineStatus } from '@shared/ipc'
import { detectSelf } from './detect-self'
import type { FeedPilot, FeedSnapshot } from './feed-snapshot'

/** What the status depends on. */
export interface SelfStatusInput {
  /** The network chosen in Settings. */
  network: OnlineNetwork | null
  /** The pilot's member number on that network, or null. */
  memberId: string | null
  /** The flight being tracked, or null when none is. */
  flight: { departure: string; arrival: string } | null
  position: LatLon | null
  /** Dev build only. */
  pretendCallsign: string | null
}

/** The status and the pilot found (main only: the pilot carries a member number and is never published). */
export interface SelfStatus {
  status: OnlineStatus
  pilot: FeedPilot | null
}

/**
 * @param network The network chosen, or null.
 * @returns The status before anything has been looked up.
 */
export function unknownStatus(network: OnlineNetwork | null): OnlineStatus {
  return { network, state: 'unknown', callsign: null, filedPlan: null }
}

/**
 * @param snapshot The latest feed, or null when none has been read.
 * @param input The network, the member number, the flight and the aircraft's position.
 * @returns Unknown when there is no network, no flight tracked or no feed of that network yet; otherwise what the feed says.
 */
export function selfStatus(snapshot: FeedSnapshot | null, input: SelfStatusInput): SelfStatus {
  if (!input.network || !input.flight || !snapshot || snapshot.network !== input.network) {
    return { status: unknownStatus(input.network), pilot: null }
  }
  const match = detectSelf(snapshot, {
    memberId: input.memberId,
    flight: input.flight,
    position: input.position,
    pretendCallsign: input.pretendCallsign
  })
  return { status: { network: input.network, ...match.status }, pilot: match.pilot }
}
