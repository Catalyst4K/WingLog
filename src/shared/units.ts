/**
 * The unit constants and plain conversions both main and the renderer use. SI is stored
 * end-to-end; aviation units appear only at the edges (docs/decisions.md §5). Formatting for
 * display stays in the renderer's units.ts.
 */

/** Metres in a foot (the international foot, exact). */
export const METRES_PER_FOOT = 0.3048

/** Kilograms in a pound (the avoirdupois pound, exact). */
export const KG_PER_LB = 0.45359237

/** Metres per second in a knot. */
export const MS_PER_KT = 0.514444

/**
 * @param m Metres.
 * @returns Feet.
 */
export function mToFt(m: number): number {
  return m / METRES_PER_FOOT
}

/**
 * Vertical speed in feet per minute — the unit pilots actually think and set landing
 * thresholds in, unlike the SI m/s stored everywhere else.
 *
 * @param ms Metres per second.
 * @returns Feet per minute.
 */
export function msToFpm(ms: number): number {
  return (ms / METRES_PER_FOOT) * 60
}
