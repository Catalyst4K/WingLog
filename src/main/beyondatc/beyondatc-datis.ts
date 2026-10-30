/**
 * BeyondATC's D-ATIS lines (winglog-backend docs/plans/beyondatc-atis.md, docs/beyondatc-notes.md 2026-10-29): `DATIS: <ICAO>|<letter>|<text>`,
 * one per airport. Pure: the text is BeyondATC's, third-party data, so a line that is not the expected shape is dropped, and only a matched
 * two-digit runway and its side ever leave the text reader.
 */
import type { BeyondAtcAtis } from '@shared/ipc'

/** The longest ATIS text kept; BeyondATC's own are about 250 characters. */
const MAX_TEXT = 2_000

const RUNWAY = /^\d{2}[LRC]?$/

// eslint-disable-next-line no-control-regex -- stripping control characters from third-party text is the point of this expression
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g

/**
 * @param value The part of a `DATIS:` line after the key, trimmed: `EGLL|R|EGLL ATIS R 2338Z …`.
 * @returns The airport's ATIS with its runways read, or null when the line is not an ICAO, a letter and a text.
 */
export function parseDatisLine(value: string): BeyondAtcAtis | null {
  const first = value.indexOf('|')
  const second = first < 0 ? -1 : value.indexOf('|', first + 1)
  if (second < 0) return null
  const icao = value.slice(0, first).trim().toUpperCase()
  const letter = value
    .slice(first + 1, second)
    .trim()
    .toUpperCase()
  const text = value
    .slice(second + 1)
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT)
  if (!/^[A-Z0-9]{4}$/.test(icao) || text === '') return null
  const { arrival, departure } = atisRunwaysFromBeyondAtc(text)
  return {
    icao,
    code: /^[A-Z]$/.test(letter) ? letter : null,
    text,
    arrivalRunways: arrival,
    departureRunways: departure
  }
}

/**
 * @param tokens The text's words.
 * @param from The first index that may hold a runway.
 * @returns The runways listed from there ("20C 20R"), with "AND" and commas allowed between, stopping at the first other word.
 */
function runwaysFrom(tokens: string[], from: number): string[] {
  const found: string[] = []
  for (let i = from; i < tokens.length; i++) {
    const token = (tokens[i] ?? '').replace(/,$/, '')
    if (token === 'AND') continue
    if (!RUNWAY.test(token)) break
    const number = Number(token.slice(0, 2))
    if (number < 1 || number > 36) return []
    if (!found.includes(token)) found.push(token)
  }
  return found
}

/**
 * Reads the runways BeyondATC labels in an ATIS: `ARR RWY 27 RIGHT DEP RWY 27 LEFT`, `ARR RWY 22 LEFT 31 LEFT 31 RIGHT DEP RWY 31 LEFT`
 * (several arrival runways) and `RWY 20 CENTER IN USE` (one runway for both). A side word becomes its letter ("27 RIGHT" is 27R).
 *
 * @param text The ATIS text.
 * @returns The arrival and departure runways, each empty when the text does not name any cleanly.
 */
export function atisRunwaysFromBeyondAtc(text: string): { arrival: string[]; departure: string[] } {
  const tokens = text
    .toUpperCase()
    .replace(
      /\b(\d{2})\s+(LEFT|RIGHT|CENTER|CENTRE)\b/g,
      (_all, number: string, side: string) => number + side[0]
    )
    .split(/\s+/)
  let arrival: string[] = []
  let departure: string[] = []
  tokens.forEach((token, i) => {
    const label = tokens[i - 1]
    if (token !== 'RWY' && token !== 'RWYS') return
    const runways = runwaysFrom(tokens, i + 1)
    if (label === 'ARR') arrival = runways
    else if (label === 'DEP') departure = runways
    else if (
      runways.length > 0 &&
      tokens
        .slice(i + 1 + runways.length)
        .slice(0, 2)
        .join(' ') === 'IN USE'
    ) {
      arrival = runways
      departure = runways
    }
  })
  return { arrival, departure }
}
