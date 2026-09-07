// SI is stored internally end-to-end; convert to aviation units only here, at the UI
// layer, per docs/decisions.md §5.
import type { AltitudeUnit, WeightUnit } from '@shared/ipc'

const KG_PER_LB = 0.45359237

export function kgToLb(kg: number): number {
  return kg / KG_PER_LB
}

export function lbToKg(lb: number): number {
  return lb * KG_PER_LB
}

const M_PER_FT = 0.3048

export function mToFt(m: number): number {
  return m / M_PER_FT
}

const MS_PER_KT = 0.514444

export function msToKt(ms: number): number {
  return ms / MS_PER_KT
}

/** Vertical speed in feet per minute — the unit pilots actually think and set landing
 *  thresholds in, unlike the SI m/s stored everywhere else. */
export function msToFpm(ms: number): number {
  return (ms / M_PER_FT) * 60
}

/** Converts a stored kg value to the user's preferred display unit. */
export function kgToUnit(kg: number, unit: WeightUnit): number {
  return unit === 'kg' ? kg : kgToLb(kg)
}

/** Converts a value in the user's preferred unit back to kg for storage. */
export function unitToKg(value: number, unit: WeightUnit): number {
  return unit === 'kg' ? value : lbToKg(value)
}

export function formatWeight(kg: number | null, unit: WeightUnit): string {
  return kg == null ? '—' : `${Math.round(kgToUnit(kg, unit)).toLocaleString()} ${unit}`
}

/** Shared by Logbook and Fleet's per-aircraft flight list. */
export function formatMinutes(min: number | null): string {
  if (min == null) return '—'
  const hours = Math.floor(min / 60)
  const minutes = Math.round(min % 60)
  return `${hours}h ${minutes}m`
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
      return `${Math.round(altitudeFt * M_PER_FT).toLocaleString()} m`
    case 'hybrid':
      return native
        ? `${Math.round(native.value).toLocaleString()} ${native.unit}`
        : `${Math.round(altitudeFt).toLocaleString()} ft`
  }
}
