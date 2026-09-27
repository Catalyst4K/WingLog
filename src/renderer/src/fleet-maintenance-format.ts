/** Display formatting for AircraftMaintenanceCard's rows — separate from
 *  src/main/*, which only ever hands over a raw formatted number with no unit or rounding
 *  opinion (CLAUDE.md: "aviation units only at the UI layer"). Units and rounding below are
 *  only added for field keys Callum has confirmed the real-world meaning and precision of
 *  (2026-09-25) — everything else (PMDG's wheel/fuel/volume/temperature fields, whose
 *  real-world units the original spike never confirmed) is still shown as the plain,
 *  unrounded number, same as before. */

/** iniBuilds A350-only — confirmed a 0-100 percentage ("life left"), not a raw
 *  voltage/capacity figure. */
const PERCENT_FIELDS = new Set(['batteryPct', 'batteryEmergencyPct'])

/** Accumulated running time — but the raw field is in seconds, not hours despite the name
 *  (confirmed by Callum, 2026-09-25: a real B-LRJ apu_hours of 30160.400391 matches "just
 *  over 8 hours" only once divided by 3600, not read as-is). `oilQuantity` is deliberately
 *  excluded here even though it's shown alongside these — its unit still isn't confirmed,
 *  only that the raw number itself is meaningful to Callum without one. */
const HOURS_FIELDS = new Set(['apuHours', 'engineHours'])
const SECONDS_PER_HOUR = 3600

/** Confirmed meaningful but with no real-world unit — shown rounded to one decimal place
 *  rather than the source file's raw ~6 decimal digits of floating-point noise.
 *  `oilQuantity` is shared with PMDG's own engine oil reading, so this also cleans up that
 *  add-on's display; PMDG's own values are already whole numbers, so rounding is a no-op
 *  for them. */
const ROUNDED_ONE_DECIMAL_FIELDS = new Set(['oilQuantity', 'apuOilQuantity', 'hydraulicsReservoir'])

/** A count, not a measurement — shown as a whole number. */
const ROUNDED_WHOLE_FIELDS = new Set(['apuStartCycles'])

function roundTo(value: number, decimals: number): string {
  // Number(...toFixed(n)) rather than toFixed(n) directly, so an integer value (e.g. PMDG's
  // oil quantity) doesn't grow a trailing ".0" that was never in the source data.
  return String(Number(value.toFixed(decimals)))
}

export function formatMaintenanceValue(key: string, rawValue: string): string {
  const n = Number(rawValue)
  if (!Number.isFinite(n)) return rawValue
  if (PERCENT_FIELDS.has(key)) return `${roundTo(n, 0)}%`
  if (HOURS_FIELDS.has(key)) return `${roundTo(n / SECONDS_PER_HOUR, 1)} h`
  if (ROUNDED_WHOLE_FIELDS.has(key)) return roundTo(n, 0)
  if (ROUNDED_ONE_DECIMAL_FIELDS.has(key)) return roundTo(n, 1)
  return rawValue
}

/** The A350's two hydraulic systems are colour-coded (Yellow/Green) in iniBuilds itself, not
 *  numbered — confirmed by Callum (2026-09-25). iniBuilds only ever ships two systems, so
 *  anything outside 1/2 falls back to the generic numbered label rather than guessing a
 *  third colour. PMDG's own `hydraulics` group uses different field keys entirely
 *  (hydraulicsVolume/hydraulicsTemp), so this never affects its display. */
export function maintenanceFieldLabelKey(key: string, index: number | undefined): string {
  if (key === 'hydraulicsReservoir' && index === 1) return 'fleetView.maintenance.fields.hydraulicsReservoirYellow'
  if (key === 'hydraulicsReservoir' && index === 2) return 'fleetView.maintenance.fields.hydraulicsReservoirGreen'
  return `fleetView.maintenance.fields.${key}`
}
