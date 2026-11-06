/**
 * The hold-short bar (winglog-backend docs/plans/v2-design.md, Part 3): a red stop bar across the end of the cleared taxi line where it
 * stops at a holding point or short of a runway. The PC works out whether it is still there (it clears when BeyondATC says line up and wait
 * or cleared for takeoff) and the screens only draw what the `taxiRoute` topic says, so the PC window and a phone always agree.
 */
import type { BeyondAtcTranscriptEntry } from '../ipc'
import { destinationPoint, initialBearingDeg } from '../geo'

/** What ATC says to let an aircraft go past a hold-short bar: onto the runway, or away on it. */
const CLEARS_THE_BAR = /line ?up and wait|cleared for take ?-?off/i

/** The runway number ATC names in a line ("runway 20C", "runway 2 7 left"), or null when it names none. */
const RUNWAY_NUMBER = /runway\s+(\d)\s?(\d)?/i

/** How wide the bar is across the taxiway, metres (about the width of a runway holding position marking). */
const BAR_WIDTH_M = 24

/**
 * @param runway A runway ident like "20C".
 * @returns Its number as two digits, or null when it has none.
 */
function runwayNumber(runway: string): string | null {
  const digits = /^(\d{1,2})/.exec(runway.trim())?.[1]
  return digits ? digits.padStart(2, '0') : null
}

/**
 * Whether one line of the transcript lets the aircraft past the bar: ATC speaking to us, after the bar appeared, saying line up and wait
 * or cleared for takeoff, for the bar's runway or for none named (a line for another runway is not ours).
 *
 * @param entry A transcript line.
 * @param runway The runway the bar is short of, as cleared ("20C"), or null for a holding point.
 * @param since When the bar appeared, epoch ms.
 * @returns Whether the bar clears.
 */
export function clearsHoldShort(
  entry: Pick<BeyondAtcTranscriptEntry, 'speaker' | 'text' | 'ts'>,
  runway: string | null,
  since: number
): boolean {
  if (entry.speaker !== 'atc' || entry.ts < since || !CLEARS_THE_BAR.test(entry.text)) return false
  const named = RUNWAY_NUMBER.exec(entry.text)
  const spoken = named ? `${named[1]}${named[2] ?? ''}`.padStart(2, '0') : null
  const ours = runway === null ? null : runwayNumber(runway)
  return spoken === null || ours === null || spoken === ours
}

/**
 * The two ends of the bar: across the line's last stretch, centred on its end.
 *
 * @param line The line left to taxi, [lon, lat], ending at the holding point.
 * @returns The bar's two ends as [lon, lat], or null when the line is too short to say which way it points.
 */
export function holdShortBarEnds(line: [number, number][]): [[number, number], [number, number]] | null {
  const end = line.at(-1)
  // The last point that is not the end itself: a line may repeat its end.
  const before = [...line].reverse().find((p) => p[0] !== end?.[0] || p[1] !== end?.[1])
  if (!end || !before) return null
  const heading = initialBearingDeg({ lat: before[1], lon: before[0] }, { lat: end[1], lon: end[0] })
  const at = { lat: end[1], lon: end[0] }
  const left = destinationPoint(at, heading - 90, BAR_WIDTH_M / 2)
  const right = destinationPoint(at, heading + 90, BAR_WIDTH_M / 2)
  return [
    [left.lon, left.lat],
    [right.lon, right.lat]
  ]
}
