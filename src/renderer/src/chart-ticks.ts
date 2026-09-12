/**
 * Standard tick steps for Logbook's altitude/speed charts (docs/plans/
 * logbook-detail-improvements.md, item 1) — replaces Recharts' default category axis,
 * which produced ragged decimal labels (whatever `tHr` value fell at an evenly-spaced
 * index) and squashed/stretched the chart shape since track points aren't evenly spaced
 * in time (LogbookView.tsx now plots against a real `type="number"` time axis instead).
 *
 * Both charts share one underlying data field, `tMin` (unrounded elapsed minutes) — the
 * hours/minutes toggle only changes which ladder is used to pick a step and how the tick
 * labels are formatted, never the axis's own data key or domain.
 */

// Chosen to give "about eight ticks or fewer" per the plan — a minutes axis only ever
// shows a flight under HOURS_AXIS_THRESHOLD_MIN long (LogbookView.tsx), so 30 min is
// already a generous top step; a longer flight switches to the hours ladder below instead
// of climbing further up this one.
export const MINUTES_TICK_LADDER = [5, 10, 15, 30] as const

// In hours — the plan describes this ladder as "15 / 30 / 60 / 120 min on an hours axis",
// which is exactly 0.25 / 0.5 / 1 / 2 h.
export const HOURS_TICK_LADDER = [0.25, 0.5, 1, 2] as const

const MAX_TICKS = 8

/**
 * Smallest step from `ladder` that keeps the axis to `maxTicks` intervals or fewer over
 * `duration`. Falls back to the ladder's largest step when even that isn't enough (a very
 * long duration) — there's nothing bigger to pick.
 */
export function pickTickStep(duration: number, ladder: readonly number[], maxTicks = MAX_TICKS): number {
  for (const step of ladder) {
    if (Math.ceil(duration / step) <= maxTicks) return step
  }
  return ladder[ladder.length - 1]
}

/**
 * Tick values from 0 up to (and including) whatever multiple of `step` first reaches or
 * passes `maxValue` — so the axis's last tick always covers the full duration, even when
 * it doesn't divide evenly. Computed as `i * step` (not by repeated addition) so every
 * value is an exact multiple of `step`, with no floating-point drift for a formatter to
 * trip over.
 */
export function buildTicks(step: number, maxValue: number): number[] {
  if (step <= 0) return [0]
  const count = Math.max(0, Math.ceil(maxValue / step))
  return Array.from({ length: count + 1 }, (_, i) => i * step)
}

export interface ChartAxisTicks {
  /** Tick positions in minutes — the same unit as the chart's `tMin` data field, so these
   *  can be passed straight to Recharts' `XAxis ticks` prop regardless of display unit. */
  ticksMin: number[]
  /** The step size in the axis's *displayed* unit (minutes for a minutes axis, hours for
   *  an hours axis) — only meaningful for formatting tick labels at the right precision. */
  stepDisplay: number
}

/** Picks a step and builds ticks for one of Logbook's time axes. `durationMin` is always
 *  in minutes (elapsed time since the first track point); `useHoursAxis` selects which
 *  ladder governs the step and switches the returned ticks' *label* unit — the tick
 *  *positions* are always converted back to minutes so they land correctly on the shared
 *  `tMin` data field either way. */
export function computeChartAxisTicks(durationMin: number, useHoursAxis: boolean): ChartAxisTicks {
  if (useHoursAxis) {
    const durationHr = durationMin / 60
    const stepHr = pickTickStep(durationHr, HOURS_TICK_LADDER)
    const ticksHr = buildTicks(stepHr, durationHr)
    return { ticksMin: ticksHr.map((hr) => hr * 60), stepDisplay: stepHr }
  }
  const stepMin = pickTickStep(durationMin, MINUTES_TICK_LADDER)
  return { ticksMin: buildTicks(stepMin, durationMin), stepDisplay: stepMin }
}

/** Formats a tick already converted to its display unit, dropping trailing zeros (e.g.
 *  "0.25", "0.5", "1", "1.5" for hours; whole numbers for minutes) — plain
 *  `Number.prototype.toString()` already does this, this just rounds away any float
 *  noise first (e.g. 0.1 + 0.2 style drift) before that conversion. */
export function formatTickLabel(value: number): string {
  return String(Math.round(value * 1000) / 1000)
}
