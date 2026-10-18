/**
 * Which GSX receipts belong to a flight: by time window, airport and tail, from the file names
 * alone.
 */
import type { ParsedReceiptFilename } from './filename'

/** Services are ordered before block-out and land after block-in (de-icing, arrival
 *  handling) — generous on purpose since tail+ICAO already does most of the
 *  discriminating (docs/gsx-notes.md). Narrow later if it over-matches in practice. */
const WINDOW_TOLERANCE_MS = 2 * 60 * 60 * 1000

export interface FlightMatchWindow {
  depIcao: string
  arrIcao: string
  registration: string
  /** actualOutUtc (or schedOutUtc as a fallback for a flight tracking hasn't started
   *  yet) — null skips the time check entirely rather than matching everything. */
  windowStartUtc: string | null
  windowEndUtc: string | null
}

function withinWindow(timestampUtc: string, window: FlightMatchWindow): boolean {
  if (!window.windowStartUtc && !window.windowEndUtc) return false
  const t = new Date(timestampUtc).getTime()
  const start = window.windowStartUtc
    ? new Date(window.windowStartUtc).getTime() - WINDOW_TOLERANCE_MS
    : -Infinity
  const end = window.windowEndUtc ? new Date(window.windowEndUtc).getTime() + WINDOW_TOLERANCE_MS : Infinity
  return t >= start && t <= end
}

function icaoMatches(receipt: ParsedReceiptFilename, window: FlightMatchWindow): boolean {
  // Both departure and arrival, since it isn't yet confirmed whether GSX also writes
  // receipts at the arrival airport — allowing both costs nothing and handles it if so
  // (docs/gsx-notes.md, "still unverified").
  const icao = receipt.icao.toUpperCase()
  return icao === window.depIcao.toUpperCase() || icao === window.arrIcao.toUpperCase()
}

/**
 * A confident match, safe to auto-attach: exact tail (never type — aircraftType reflects
 * whatever was loaded in the sim at receipt time and is demonstrably unreliable, per
 * docs/gsx-notes.md), departure-or-arrival ICAO, and a timestamp within the flight's
 * window plus tolerance. NOTAIL receipts never match here — see isNotailCandidate.
 *
 * @param receipt The receipt's file name, parsed.
 * @param window The flight's tail, airports and time window.
 * @returns Whether it's the flight's.
 */
export function matchesFlight(receipt: ParsedReceiptFilename, window: FlightMatchWindow): boolean {
  if (receipt.tail.toUpperCase() === 'NOTAIL' || !receipt.tail) return false
  if (receipt.tail.toUpperCase() !== window.registration.toUpperCase()) return false
  if (!icaoMatches(receipt, window)) return false
  return withinWindow(receipt.timestampUtc, window)
}

/**
 * A NOTAIL receipt can only be matched on time and airport — not enough to be sure, so
 * these are offered as "possibly this flight" rather than auto-attached (docs/gsx-notes.md
 * — matching to flights, "offered, not auto-attached").
 *
 * @param receipt The receipt's file name, parsed.
 * @param window The flight's tail, airports and time window.
 * @returns Whether it could be the flight's.
 */
export function isNotailCandidate(receipt: ParsedReceiptFilename, window: FlightMatchWindow): boolean {
  if (receipt.tail.toUpperCase() !== 'NOTAIL') return false
  if (!icaoMatches(receipt, window)) return false
  return withinWindow(receipt.timestampUtc, window)
}
