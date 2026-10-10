/** Reads the hold-short runway from ATC's spoken taxi clearance. */

// One taxiway name: letters/digits, optionally followed by a space and a number. Heathrow's
// link taxiways are named that way ("taxi via E, LINK 36, F, A, R, hold short of runway
// 27L"). Only a number may follow the space, so a list can't swallow
// ordinary words after it.
const TAXIWAY = String.raw`[A-Z0-9]+(?: \d+)?`
const TAXIWAY_LIST = `${TAXIWAY}(?:, ${TAXIWAY})*`

// The first half of a split taxi clearance (heard after landing): "taxi via
// C7, Y, F, hold short of runway 07C." The stand comes in a second clearance once across.
const HOLD_SHORT_TAXI = new RegExp(String.raw`taxi via ${TAXIWAY_LIST}, hold short of runway (\w+)`, 'i')

/**
 * "taxi via C7, Y, F, hold short of runway 07C" → '07C'. Null for anything else.
 *
 * The only part of a taxi clearance still read from ATC's speech: the route, holding point and
 * gate come from BeyondATC's InfoBoxes, and no hold-short box has been seen (winglog-backend's
 * docs/decisions.md, 2026-10-05). The full speech parsers are in git history (this file as of
 * `develop` 72c267b).
 *
 * @param text ATC's spoken line.
 * @returns The runway to hold short of, or null.
 */
export function parseTaxiHoldShortRunway(text: string): string | null {
  return HOLD_SHORT_TAXI.exec(text)?.[1] ?? null
}
