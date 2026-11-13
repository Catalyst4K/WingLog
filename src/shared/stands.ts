/** Finding a stand by position or by the name ATC uses. */

import type { NavdataStand } from './ipc'
import { flatDistanceM as distanceM } from './geo'

/** How far from a stand's own point an aircraft can stop and still be "at" it — real
 *  flights stopped 13 m from a stand and started 15 m from a gate. */
export const AT_STAND_MAX_M = 40

/**
 * The stand an aircraft is parked at, or null if none is close enough.
 *
 * @param stands The airport's stands.
 * @param position The aircraft's position.
 * @param maxM How far from a stand still counts as at it, in metres.
 * @returns The nearest stand within `maxM`, or null.
 */
export function nearestStand(
  stands: NavdataStand[],
  position: { lat: number; lon: number },
  maxM = AT_STAND_MAX_M
): NavdataStand | null {
  let best: NavdataStand | null = null
  let bestDistance = maxM
  for (const stand of stands) {
    const d = distanceM(stand, position)
    if (d <= bestDistance) {
      best = stand
      bestDistance = d
    }
  }
  return best
}

/** The sim's TAXI_PARKING NAME enum: 12 is GATE_A, and each letter after it is one more, up to 37 for GATE_Z. The SUFFIX field uses the same codes. */
const GATE_A_NAME_CODE = 12
const LETTER_COUNT = 26

/**
 * @param nameCode TAXI_PARKING's NAME (or SUFFIX) value.
 * @returns The letter it stands for ('N' for GATE_N, 25), or '' for a code that is no letter (none, parking, gate, dock).
 */
export function letterOfNameCode(nameCode: number): string {
  const index = nameCode - GATE_A_NAME_CODE
  return index >= 0 && index < LETTER_COUNT ? String.fromCharCode(65 + index) : ''
}

/**
 * @param letter A capital letter, A to Z.
 * @returns The TAXI_PARKING NAME / SUFFIX code for it (R is 29, L is 23, B is 13).
 */
function nameCodeOfLetter(letter: string): number {
  return GATE_A_NAME_CODE + letter.charCodeAt(0) - 65
}

/**
 * The stand ATC named ("N32", or "N32R" for the twin the sim gives suffix 29). A name can have twin entries (a MARS stand's halves,
 * carrying a non-zero suffix); ATC's plain name means the one without, and a letter after the number means the twin with that suffix.
 *
 * @param stands The airport's stands.
 * @param name The name ATC gave.
 * @returns The stand, or null if the airport has none by that name.
 */
export function findStand(stands: NavdataStand[], name: string): NavdataStand | null {
  const upper = name.toUpperCase()
  const matches = stands.filter((s) => s.name.toUpperCase() === upper)
  if (matches.length > 0) return matches.find((s) => s.suffix === 0) ?? matches[0] ?? null
  const lettered = /^(.*\d)([A-Z])$/.exec(upper)
  if (!lettered) return null
  const [, base, letter] = lettered
  const twins = stands.filter((s) => s.name.toUpperCase() === base)
  // A letter with no twin of its own is still the stand, to within the twins' 17 m.
  return (
    twins.find((s) => s.suffix === nameCodeOfLetter(letter ?? '')) ??
    twins.find((s) => s.suffix === 0) ??
    twins[0] ??
    null
  )
}
