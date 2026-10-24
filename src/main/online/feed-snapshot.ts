/**
 * The one internal form both networks' feeds are parsed into, and the function that picks the aircraft near a point.
 *
 * Main keeps the whole snapshot; a screen only ever gets `trafficNear`'s trimmed copy, which carries no member numbers or names. A
 * `FeedSnapshot` is never published, exported or logged, so IVAO's confidentiality rule (Regulation D.2) holds by construction.
 * Plan: winglog-backend docs/plans/vatsim-build.md, "The internal form".
 */
import { greatCircleM, type LatLon } from '@shared/geo'
import type { OnlineNetwork, TrafficAircraft } from '@shared/ipc'

/** How far from the aircraft traffic is shown: at cruise the follow zoom spans about 200 nm, so this fills the screen with margin. */
export const TRAFFIC_RADIUS_M = 250 * 1852

/** The most aircraft one payload carries: about 60 kB a refresh to the phone, and the nearest are the ones on screen. */
export const TRAFFIC_MAX_AIRCRAFT = 400

/** One pilot as the feeds report them, in SI units. */
export interface FeedPilot {
  /** The CID or VID. Main only: used to recognise the pilot's own aircraft. Null when the feed lacks one. */
  memberId: string | null
  callsign: string
  latitude: number
  longitude: number
  altitudeM: number
  groundSpeedMs: number
  /** True heading, degrees. */
  headingDeg: number
  onGround: boolean
  aircraftIcao: string | null
  departure: string | null
  arrival: string | null
  /** How old the position was when the feed was generated, seconds. */
  ageAtFeedS: number
}

/** The kind of station a controller runs (VATSIM's facility numbers and IVAO's positions, in one set). */
export type ControllerPosition = 'fss' | 'del' | 'gnd' | 'twr' | 'app' | 'ctr'

/** An online controller. Observers are never one. */
export interface FeedController {
  callsign: string
  /** MHz with three decimals, for example "131.900". */
  frequency: string
  position: ControllerPosition
}

/** An airport's ATIS, as text. */
export interface FeedAtis {
  callsign: string
  /** The information letter, or null when none is given. */
  code: string | null
  lines: string[]
}

/** A whole feed, parsed. */
export interface FeedSnapshot {
  network: OnlineNetwork
  /** When the feed says it was generated, or null when it gives no usable time. */
  updatedMs: number | null
  /** When this snapshot was received here: the glide and the ages count from it. */
  receivedMs: number
  pilots: FeedPilot[]
  controllers: FeedController[]
  atis: FeedAtis[]
}

/** What `trafficNear` is asked for. */
export interface TrafficNearOptions {
  radiusM: number
  max: number
  /** The pilot's own member number: that aircraft is left out. */
  excludeMemberId?: string | null
  /** The pilot's own callsign when found by plan rather than member number: that aircraft is left out too. */
  excludeCallsign?: string | null
  nowMs: number
}

/**
 * The aircraft within a radius of a point, nearest first.
 *
 * @param snapshot The parsed feed.
 * @param centre Where to look around.
 * @param options The radius (metres), the most aircraft, the member to leave out, and the time the payload is made at.
 * @returns At most `max` aircraft, as a screen draws them: no member numbers.
 */
export function trafficNear(
  snapshot: FeedSnapshot,
  centre: LatLon,
  options: TrafficNearOptions
): TrafficAircraft[] {
  const sinceReceivedS = Math.max(0, (options.nowMs - snapshot.receivedMs) / 1000)
  return snapshot.pilots
    .filter((pilot) => options.excludeMemberId == null || pilot.memberId !== options.excludeMemberId)
    .filter((pilot) => options.excludeCallsign == null || pilot.callsign !== options.excludeCallsign)
    .map((pilot) => ({
      pilot,
      distanceM: greatCircleM(centre, { lat: pilot.latitude, lon: pilot.longitude })
    }))
    .filter(({ distanceM }) => distanceM <= options.radiusM)
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, options.max)
    .map(({ pilot }) => ({
      key: pilot.callsign,
      callsign: pilot.callsign,
      latitude: pilot.latitude,
      longitude: pilot.longitude,
      altitudeM: pilot.altitudeM,
      groundSpeedMs: pilot.groundSpeedMs,
      headingDeg: pilot.headingDeg,
      onGround: pilot.onGround,
      aircraftIcao: pilot.aircraftIcao,
      departure: pilot.departure,
      arrival: pilot.arrival,
      ageS: pilot.ageAtFeedS + sinceReceivedS
    }))
}
