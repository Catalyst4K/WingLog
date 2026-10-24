/**
 * Reads VATSIM's v3 data feed (data.vatsim.net/v3/vatsim-data.json) into a `FeedSnapshot`. Pure: the JSON is already parsed.
 *
 * Findings behind the choices (winglog-backend docs/vatsim-notes.md): `heading` is true (checked against two positions of 821 cruising
 * aircraft), altitude is feet and ground speed knots, there is no on-ground flag, and observers sit among the controllers with facility 0
 * and frequency 199.998. Any record that fails a check is dropped; a feed without a `pilots` array is no feed.
 */
import type { OnlineNetwork } from '@shared/ipc'
import {
  MAX_AIRPORT_CHARS,
  MAX_CALLSIGN_CHARS,
  MAX_FEED_RECORDS,
  MAX_TYPE_CHARS,
  ageSeconds,
  asRecord,
  cleanText,
  clippedText,
  feedTime,
  formatFrequency,
  memberId,
  parseMotion,
  textLines
} from './feed-fields'
import type { ControllerPosition, FeedAtis, FeedController, FeedPilot, FeedSnapshot } from './feed-snapshot'

const NETWORK: OnlineNetwork = 'vatsim'

/** The longest controller name kept. */
const MAX_NAME_CHARS = 40

/**
 * VATSIM has no on-ground flag, so a pilot at or under this ground speed is taken to be on the ground. In the 2026-10-24 captures 585 of
 * 1,791 pilots were under it, and on IVAO (which does flag it) only 2 of 725 airborne pilots were.
 */
export const VATSIM_GROUND_SPEED_KT = 40

/** The feed's facility numbers for the positions WingLog lists; 0 is an observer and is never listed. */
const FACILITY_POSITIONS: Record<number, ControllerPosition> = {
  1: 'fss',
  2: 'del',
  3: 'gnd',
  4: 'twr',
  5: 'app',
  6: 'ctr'
}

/**
 * @param value A pilot's `flight_plan` field.
 * @returns The aircraft type, departure and arrival it names (each null when absent).
 */
function readPlan(value: unknown): Pick<FeedPilot, 'aircraftIcao' | 'departure' | 'arrival'> {
  const plan = asRecord(value)
  return {
    aircraftIcao: clippedText(plan?.aircraft_short, MAX_TYPE_CHARS),
    departure: clippedText(plan?.departure, MAX_AIRPORT_CHARS),
    arrival: clippedText(plan?.arrival, MAX_AIRPORT_CHARS)
  }
}

/**
 * @param value One entry of `pilots`.
 * @param updatedMs When the feed was generated.
 * @returns The pilot, or null when any needed field is missing or out of range.
 */
function readPilot(value: unknown, updatedMs: number | null): FeedPilot | null {
  const pilot = asRecord(value)
  if (!pilot) return null
  const callsign = cleanText(pilot.callsign, MAX_CALLSIGN_CHARS)
  const motion = parseMotion(
    pilot.latitude,
    pilot.longitude,
    pilot.altitude,
    pilot.groundspeed,
    pilot.heading
  )
  if (!callsign || !motion) return null
  return {
    memberId: memberId(pilot.cid),
    callsign,
    ...motion,
    onGround: (pilot.groundspeed as number) < VATSIM_GROUND_SPEED_KT,
    ...readPlan(pilot.flight_plan),
    ageAtFeedS: ageSeconds(updatedMs, pilot.last_updated)
  }
}

/**
 * @param value One entry of `controllers`.
 * @returns The controller, or null for an observer or an entry that cannot be read.
 */
function readController(value: unknown): FeedController | null {
  const controller = asRecord(value)
  if (!controller) return null
  const position =
    typeof controller.facility === 'number' ? FACILITY_POSITIONS[controller.facility] : undefined
  const callsign = cleanText(controller.callsign, MAX_CALLSIGN_CHARS + 8)
  const frequency = formatFrequency(Number(controller.frequency))
  const name = clippedText(controller.name, MAX_NAME_CHARS)
  return position && callsign && frequency ? { callsign, frequency, position, name } : null
}

/**
 * @param value One entry of `atis`.
 * @returns The ATIS, or null when it has no callsign or no text.
 */
function readAtis(value: unknown): FeedAtis | null {
  const atis = asRecord(value)
  const callsign = cleanText(atis?.callsign, MAX_CALLSIGN_CHARS + 8)
  const lines = textLines(atis?.text_atis)
  return callsign && lines.length > 0 ? { callsign, code: clippedText(atis?.atis_code, 2), lines } : null
}

/**
 * @param entries A list from the feed, or anything else.
 * @param read Reads one entry.
 * @returns What could be read from the first `MAX_FEED_RECORDS` entries.
 */
function readAll<T>(entries: unknown, read: (entry: unknown) => T | null): T[] {
  if (!Array.isArray(entries)) return []
  return entries
    .slice(0, MAX_FEED_RECORDS)
    .map(read)
    .filter((item): item is T => item !== null)
}

/**
 * Parses one VATSIM data feed.
 *
 * @param raw The feed's JSON, already parsed, or anything at all.
 * @param receivedMs When it was received (epoch milliseconds).
 * @returns The snapshot, or null when it is not a feed (no `pilots` array).
 */
export function parseVatsimFeed(raw: unknown, receivedMs: number): FeedSnapshot | null {
  const feed = asRecord(raw)
  if (!feed || !Array.isArray(feed.pilots)) return null
  const updatedMs = feedTime(asRecord(feed.general)?.update_timestamp)
  const seen = new Set<string>()
  const pilots = readAll(feed.pilots, (entry) => readPilot(entry, updatedMs)).filter((pilot) => {
    // A callsign is unique on the network; a repeat is a broken entry and would give two symbols one key.
    if (seen.has(pilot.callsign)) return false
    seen.add(pilot.callsign)
    return true
  })
  return {
    network: NETWORK,
    updatedMs,
    receivedMs,
    pilots,
    controllers: readAll(feed.controllers, readController),
    atis: readAll(feed.atis, readAtis)
  }
}
