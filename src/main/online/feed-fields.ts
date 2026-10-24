/**
 * Field readers for the network feeds. A feed is third-party input (CLAUDE.md, Security), so every field is checked here, once, at the
 * boundary: a bad value degrades to null and the record using it is dropped, never thrown on.
 */
import { METRES_PER_FOOT, MS_PER_KT } from '@shared/units'

/** The longest callsign accepted; a longer one is not a callsign. */
export const MAX_CALLSIGN_CHARS = 12
/** The longest ICAO aircraft type kept. */
export const MAX_TYPE_CHARS = 8
/** The longest airport code kept. */
export const MAX_AIRPORT_CHARS = 4
/** The longest controller or ATIS text line kept, and the most lines. */
export const MAX_TEXT_LINE_CHARS = 200
export const MAX_TEXT_LINES = 30
/** The most pilots or controllers read from one feed: far above the busiest event, so one broken feed cannot flood memory. */
export const MAX_FEED_RECORDS = 20_000

/** Control characters, including the escape that starts a terminal sequence. */
// eslint-disable-next-line no-control-regex -- the point is to strip them
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g

/** The sanest altitude range, feet: below the Dead Sea to above any aircraft. */
const MIN_ALTITUDE_FT = -2_000
const MAX_ALTITUDE_FT = 100_000
/** The fastest ground speed accepted, knots. */
const MAX_GROUND_SPEED_KT = 1_500

/**
 * @param value A field.
 * @param maxChars The longest allowed.
 * @returns The text with control characters removed and trimmed, or null when it is not a string, is empty, or is too long.
 */
export function cleanText(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(CONTROL_CHARS, '').trim()
  return cleaned.length > 0 && cleaned.length <= maxChars ? cleaned : null
}

/**
 * @param value A field.
 * @param maxChars The longest to keep.
 * @returns The cleaned text cut to the limit (never rejected for length), or null when it is not text or is empty.
 */
export function clippedText(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(CONTROL_CHARS, '').trim().slice(0, maxChars)
  return cleaned.length > 0 ? cleaned : null
}

/**
 * @param value A field.
 * @returns A list of cleaned, clipped text lines (at most `MAX_TEXT_LINES`), or an empty list when it is not an array.
 */
export function textLines(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .slice(0, MAX_TEXT_LINES)
    .map((line) => clippedText(line, MAX_TEXT_LINE_CHARS))
    .filter((line): line is string => line !== null)
}

/**
 * @param value A field.
 * @returns The value when it is a finite number, else null.
 */
export function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * @param value A member number field (a number in both feeds).
 * @returns Its digits, or null when it is not a positive whole number.
 */
export function memberId(value: unknown): string | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null
}

/** The numeric part of a pilot's position, already in SI. */
export interface ParsedMotion {
  latitude: number
  longitude: number
  altitudeM: number
  groundSpeedMs: number
  headingDeg: number
}

/**
 * Checks and converts a pilot's position and motion.
 *
 * @param latitude Degrees.
 * @param longitude Degrees.
 * @param altitudeFt Feet.
 * @param groundSpeedKt Knots.
 * @param headingDeg Degrees true.
 * @returns The motion in SI units, or null when any value is missing or out of range.
 */
export function parseMotion(
  latitude: unknown,
  longitude: unknown,
  altitudeFt: unknown,
  groundSpeedKt: unknown,
  headingDeg: unknown
): ParsedMotion | null {
  const lat = finiteNumber(latitude)
  const lon = finiteNumber(longitude)
  const alt = finiteNumber(altitudeFt)
  const speed = finiteNumber(groundSpeedKt)
  const heading = finiteNumber(headingDeg)
  if (lat === null || lon === null || alt === null || speed === null || heading === null) return null
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
  if (alt < MIN_ALTITUDE_FT || alt > MAX_ALTITUDE_FT) return null
  if (speed < 0 || speed > MAX_GROUND_SPEED_KT) return null
  return {
    latitude: lat,
    longitude: lon,
    altitudeM: alt * METRES_PER_FOOT,
    groundSpeedMs: speed * MS_PER_KT,
    headingDeg: ((heading % 360) + 360) % 360
  }
}

/**
 * @param feedTimeMs When the feed was generated, or null when unknown.
 * @param positionTime The pilot's position time field.
 * @returns How old the position was at that moment, seconds, never negative; 0 when either time is unusable.
 */
export function ageSeconds(feedTimeMs: number | null, positionTime: unknown): number {
  if (feedTimeMs === null || typeof positionTime !== 'string') return 0
  const positionMs = Date.parse(positionTime)
  return Number.isFinite(positionMs) ? Math.max(0, (feedTimeMs - positionMs) / 1000) : 0
}

/**
 * @param value A feed's own generation time.
 * @returns It as epoch milliseconds, or null when it is not a usable time.
 */
export function feedTime(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/**
 * @param value A field that should be a plain object.
 * @returns It as a record, or null when it is anything else.
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : null
}

/**
 * @param frequencyMhz A frequency in MHz.
 * @returns "131.900"-style text, or null when it is not a plausible VHF air-band frequency (this also drops VATSIM's 199.998 observer marker).
 */
export function formatFrequency(frequencyMhz: number): string | null {
  return frequencyMhz >= 108 && frequencyMhz < 199.99 ? frequencyMhz.toFixed(3) : null
}
