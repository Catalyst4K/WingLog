/**
 * The one internal form both networks' feeds are parsed into, and the function that picks the aircraft a screen draws.
 *
 * Main keeps the whole snapshot; a screen only ever gets `trafficToShow`'s trimmed copy, which carries no member numbers or names. A
 * `FeedSnapshot` is never published, exported or logged, so IVAO's confidentiality rule (Regulation D.2) holds by construction.
 * Plan: winglog-backend docs/plans/vatsim-build.md, "The internal form".
 */
import { greatCircleM, type LatLon } from '@shared/geo'
import type { OnlineNetwork, OnlineStationPosition, TrafficAircraft } from '@shared/ipc'

/** How far from the aircraft traffic is shown: at cruise the follow zoom spans about 200 nm, so this fills the screen with margin. */
export const TRAFFIC_RADIUS_M = 250 * 1852

/** The most aircraft one payload carries around a point: about 60 kB a refresh to the phone, and the nearest are the ones on screen. */
export const TRAFFIC_MAX_AIRCRAFT = 400

/**
 * The most aircraft with no position to centre on, when the whole network is shown (Callum, 2026-10-25: the button shows traffic
 * whatever else is known). Above VATSIM's busiest events, about 3,000 pilots, and about 600 kB a refresh: well inside the 1 MB a phone
 * may have waiting before the second screen drops it (`MAX_BUFFERED_BYTES`).
 */
export const TRAFFIC_MAX_WORLD = 3000

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

/** The kind of station a controller runs. */
export type ControllerPosition = OnlineStationPosition

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
  /** MHz with three decimals: VATSIM's ATIS stations have their own. Null on IVAO, whose ATIS is the controller's. */
  frequency: string | null
  /** IVAO: the position of the controller whose ATIS this is. Null on VATSIM, whose ATIS are stations of their own. */
  position: ControllerPosition | null
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

/** What `trafficToShow` is asked for. */
export interface TrafficOptions {
  /** With a centre: how far from it, and the most aircraft. */
  radiusM: number
  max: number
  /** With no centre: the most aircraft of the whole network. */
  maxWithoutCentre: number
  /** The pilot's own member number: that aircraft is left out. */
  excludeMemberId?: string | null
  /** The pilot's own callsign when found by plan rather than member number: that aircraft is left out too. */
  excludeCallsign?: string | null
  nowMs: number
}

/**
 * @param snapshot The parsed feed.
 * @param centre Where to look around, or null when nothing is known to centre on.
 * @param options The radius (metres) and the most aircraft, with and without a centre, the member to leave out, and the time the
 *   payload is made at.
 * @returns The aircraft a screen draws, without member numbers: those within the radius of the centre, nearest first; with no centre,
 *   the whole network in the feed's order. Never more than the most for the case.
 */
export function trafficToShow(
  snapshot: FeedSnapshot,
  centre: LatLon | null,
  options: TrafficOptions
): TrafficAircraft[] {
  const sinceReceivedS = Math.max(0, (options.nowMs - snapshot.receivedMs) / 1000)
  const others = snapshot.pilots
    .filter((pilot) => options.excludeMemberId == null || pilot.memberId !== options.excludeMemberId)
    .filter((pilot) => options.excludeCallsign == null || pilot.callsign !== options.excludeCallsign)
  const chosen =
    centre === null
      ? others.slice(0, options.maxWithoutCentre)
      : others
          .map((pilot) => ({
            pilot,
            distanceM: greatCircleM(centre, { lat: pilot.latitude, lon: pilot.longitude })
          }))
          .filter(({ distanceM }) => distanceM <= options.radiusM)
          .sort((a, b) => a.distanceM - b.distanceM)
          .slice(0, options.max)
          .map(({ pilot }) => pilot)
  return chosen.map((pilot) => ({
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
