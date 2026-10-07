/**
 * SI is stored internally end-to-end; convert to aviation units only here, at the UI
 * layer, per docs/decisions.md §5.
 */

import type { AltitudeUnit, LandingDistanceUnit, WeightUnit } from '@shared/ipc'
import { KG_PER_LB, METRES_PER_FOOT, MS_PER_KT, mToFt } from '@shared/units'

export { mToFt, msToFpm } from '@shared/units'

/**
 * @param kg Kilograms.
 * @returns Pounds.
 */
export function kgToLb(kg: number): number {
  return kg / KG_PER_LB
}

/**
 * @param lb Pounds.
 * @returns Kilograms.
 */
export function lbToKg(lb: number): number {
  return lb * KG_PER_LB
}

/**
 * @param ms Metres per second.
 * @returns Knots.
 */
export function msToKt(ms: number): number {
  return ms / MS_PER_KT
}

/**
 * Converts a stored kg value to the user's preferred display unit.
 *
 * @param kg Kilograms.
 * @param unit The display unit.
 * @returns The value in that unit.
 */
export function kgToUnit(kg: number, unit: WeightUnit): number {
  return unit === 'kg' ? kg : kgToLb(kg)
}

/**
 * Converts a value in the user's preferred unit back to kg for storage.
 *
 * @param value The value in the display unit.
 * @param unit The display unit.
 * @returns Kilograms.
 */
export function unitToKg(value: number, unit: WeightUnit): number {
  return unit === 'kg' ? value : lbToKg(value)
}

/**
 * A weight in the display unit, rounded and thousands-separated.
 *
 * @param kg Kilograms, or null.
 * @param unit The display unit.
 * @returns e.g. "12,345 lb", or a dash.
 */
export function formatWeight(kg: number | null, unit: WeightUnit): string {
  return kg == null ? '—' : `${Math.round(kgToUnit(kg, unit)).toLocaleString()} ${unit}`
}

/**
 * Shared by Logbook and Fleet's per-aircraft flight list.
 *
 * @param min Minutes, or null.
 * @returns e.g. "2h 5m", or a dash.
 */
export function formatMinutes(min: number | null): string {
  if (min == null) return '—'
  const hours = Math.floor(min / 60)
  const minutes = Math.round(min % 60)
  return `${hours}h ${minutes}m`
}

/**
 * Distance from threshold / touchdown-diagram measurements — Logbook's own unit setting
 * (docs/plans/logbook-detail-improvements.md, item 4), separate from OFP altitudes and
 * wind speed. Whole units, thousands-separated, same rounding convention as formatWeight.
 *
 * @param meters Metres.
 * @param unit The distance unit.
 * @returns The distance text.
 */
export function formatRunwayDistance(meters: number, unit: LandingDistanceUnit): string {
  const value = unit === 'ft' ? mToFt(meters) : meters
  return `${Math.round(value).toLocaleString()} ${unit}`
}

/**
 * Centreline offset reads as a side, not a raw signed number — the sign convention
 * (positive = right of centreline, looking in the landing direction — see landing-maths.ts's
 * RunwayRelativePosition) isn't obvious to someone reading the card. Exactly on the
 * centreline gets no letter, since "0 ft R" implies a side that isn't really there.
 *
 * @param meters Metres; positive is right of the centreline.
 * @param unit The distance unit.
 * @returns The offset text, e.g. "12 ft L".
 */
export function formatCentrelineOffset(meters: number, unit: LandingDistanceUnit): string {
  const magnitude = unit === 'ft' ? mToFt(Math.abs(meters)) : Math.abs(meters)
  const side = meters > 0 ? ' R' : meters < 0 ? ' L' : ''
  return `${Math.round(magnitude).toLocaleString()} ${unit}${side}`
}

/**
 * Pitch at touchdown, for display only. `pitchDeg` is stored exactly as MSFS's `PLANE PITCH DEGREES` SimVar reports it: negative
 * for nose-up, positive for nose-down (winglog-backend's docs/simconnect-notes.md, 2026-09-03; landing-score.ts's PITCH_IDEAL_DEG
 * relies on the same convention and must stay in that SimVar-native sign). That reads backwards to a pilot, who states a flare as
 * a positive "4-7° nose-up". This negates purely for display, so a -4.2° SimVar reading shows as "4.2°".
 *
 * @param pitchDeg Pitch as the SimVar reports it (negative nose-up).
 * @returns The pitch text.
 */
export function formatPitchDeg(pitchDeg: number): string {
  return `${(-pitchDeg).toFixed(1)}°`
}

/**
 * Formats an altitude that came from a SimBrief OFP. `altitudeFt` should always be a
 * real feet value (see the AltitudeUnit doc comment in shared/ipc.ts) — 'ft'/'m' convert
 * it directly. `native`, when given (a step climb's `native` field), is shown for
 * 'hybrid' instead — the unit and value the point was actually coded in on the OFP (feet
 * for a standard level, metres for a Chinese-airspace metric one) — pass it whenever the
 * caller has that available. Without it, 'hybrid' falls back to plain feet, for values
 * with no native-unit distinction, e.g. cruise altitude.
 *
 * 'ft' rounds to the nearest 100 ft (a real flight level), not the nearest foot — a
 * point whose native level is metric converts to an odd feet value (e.g. 11,300 m ≈
 * 37,073 ft), and no ATC/FMS ever assigns a level that isn't a round hundred of feet.
 * Rounding a value that's already a round hundred (every standard-level point) is a
 * no-op.
 *
 * @param altitudeFt The altitude, in feet.
 * @param unit The altitude unit.
 * @param native The unit and value it was coded in, if known.
 * @returns The altitude text.
 */
export function formatAltitude(
  altitudeFt: number,
  unit: AltitudeUnit,
  native?: { unit: 'ft' | 'm'; value: number }
): string {
  switch (unit) {
    case 'ft':
      return `${(Math.round(altitudeFt / 100) * 100).toLocaleString()} ft`
    case 'm':
      return `${Math.round(altitudeFt * METRES_PER_FOOT).toLocaleString()} m`
    case 'hybrid':
      return native
        ? `${Math.round(native.value).toLocaleString()} ${native.unit}`
        : `${Math.round(altitudeFt).toLocaleString()} ft`
  }
}
