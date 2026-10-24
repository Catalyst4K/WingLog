/**
 * Reads IVAO's Whazzup feed (api.ivao.aero/v2/tracker/whazzup) into the same `FeedSnapshot` as VATSIM's. Pure: the JSON is already parsed.
 *
 * Differences from VATSIM (winglog-backend docs/vatsim-notes.md): the position is in `lastTrack`, `onGround` is a flag, observers are a
 * separate list, a controller's frequency is a number and its ATIS lives on the controller. `heading` is true, altitude feet, speed
 * knots. IVAO's confidentiality rule (Regulation D.2): other members' data is only ever held in memory here, and shown on screen.
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
  finiteNumber,
  formatFrequency,
  memberId,
  parseMotion,
  textLines
} from './feed-fields'
import type { ControllerPosition, FeedAtis, FeedController, FeedPilot, FeedSnapshot } from './feed-snapshot'

const NETWORK: OnlineNetwork = 'ivao'

/** IVAO's controller positions that WingLog lists. */
const POSITIONS: Record<string, ControllerPosition> = {
  DEL: 'del',
  GND: 'gnd',
  TWR: 'twr',
  APP: 'app',
  CTR: 'ctr',
  FSS: 'fss'
}

/**
 * @param value A pilot's `flightPlan` field.
 * @returns The aircraft type, departure and arrival it names (each null when absent).
 */
function readPlan(value: unknown): Pick<FeedPilot, 'aircraftIcao' | 'departure' | 'arrival'> {
  const plan = asRecord(value)
  const aircraft = asRecord(plan?.aircraft)
  return {
    aircraftIcao: clippedText(aircraft?.icaoCode ?? plan?.aircraftId, MAX_TYPE_CHARS),
    departure: clippedText(plan?.departureId, MAX_AIRPORT_CHARS),
    arrival: clippedText(plan?.arrivalId, MAX_AIRPORT_CHARS)
  }
}

/**
 * @param value One entry of `clients.pilots`.
 * @param updatedMs When the feed was generated.
 * @returns The pilot, or null when it has no usable track.
 */
function readPilot(value: unknown, updatedMs: number | null): FeedPilot | null {
  const pilot = asRecord(value)
  const track = asRecord(pilot?.lastTrack)
  if (!pilot || !track) return null
  const callsign = cleanText(pilot.callsign, MAX_CALLSIGN_CHARS)
  const motion = parseMotion(
    track.latitude,
    track.longitude,
    track.altitude,
    track.groundSpeed,
    track.heading
  )
  if (!callsign || !motion) return null
  return {
    memberId: memberId(pilot.userId),
    callsign,
    ...motion,
    onGround: track.onGround === true,
    ...readPlan(pilot.flightPlan),
    ageAtFeedS: ageSeconds(updatedMs, track.timestamp)
  }
}

/**
 * @param value One entry of `clients.atcs`.
 * @returns The controller and its ATIS, either of which may be absent.
 */
function readAtc(value: unknown): { controller: FeedController | null; atis: FeedAtis | null } {
  const atc = asRecord(value)
  const session = asRecord(atc?.atcSession)
  const callsign = cleanText(atc?.callsign, MAX_CALLSIGN_CHARS + 8)
  if (!callsign) return { controller: null, atis: null }
  const position = typeof session?.position === 'string' ? POSITIONS[session.position] : undefined
  const frequencyMhz = finiteNumber(session?.frequency)
  const frequency = frequencyMhz === null ? null : formatFrequency(frequencyMhz)
  const lines = textLines(asRecord(atc?.atis)?.lines)
  return {
    controller: position && frequency ? { callsign, frequency, position } : null,
    atis: lines.length > 0 ? { callsign, code: clippedText(asRecord(atc?.atis)?.revision, 2), lines } : null
  }
}

/**
 * @param entries A list from the feed, or anything else.
 * @returns At most the first `MAX_FEED_RECORDS` entries, or an empty list.
 */
function entriesOf(entries: unknown): unknown[] {
  return Array.isArray(entries) ? entries.slice(0, MAX_FEED_RECORDS) : []
}

/**
 * Parses one Whazzup feed.
 *
 * @param raw The feed's JSON, already parsed, or anything at all.
 * @param receivedMs When it was received (epoch milliseconds).
 * @returns The snapshot, or null when it is not a feed (no `clients.pilots` array).
 */
export function parseIvaoFeed(raw: unknown, receivedMs: number): FeedSnapshot | null {
  const feed = asRecord(raw)
  const clients = asRecord(feed?.clients)
  if (!feed || !clients || !Array.isArray(clients.pilots)) return null
  const updatedMs = feedTime(feed.updatedAt)
  const seen = new Set<string>()
  const pilots = entriesOf(clients.pilots)
    .map((entry) => readPilot(entry, updatedMs))
    .filter((pilot): pilot is FeedPilot => {
      if (pilot === null || seen.has(pilot.callsign)) return false
      seen.add(pilot.callsign)
      return true
    })
  const atcs = entriesOf(clients.atcs).map(readAtc)
  return {
    network: NETWORK,
    updatedMs,
    receivedMs,
    pilots,
    controllers: atcs.map(({ controller }) => controller).filter((c): c is FeedController => c !== null),
    atis: atcs.map(({ atis }) => atis).filter((a): a is FeedAtis => a !== null)
  }
}
