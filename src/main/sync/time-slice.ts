/**
 * Lets the app breathe during a long loop. Sync reads, serialises and writes hundreds of rows (a first sync of a real logbook is 600 rows
 * and 23 MB, several seconds of work), all on the main thread that also serves the window; without a pause the app stands still for the
 * whole of it (winglog-backend's docs/plans/multi-device.md, finding F11). The loop calls the slicer after each row: most calls return at
 * once, and when a few milliseconds of work have passed it hands the thread back to everything else waiting, then carries on.
 */

/** How much work is done between pauses, milliseconds: short enough that a click or a repaint is never kept waiting for long. */
export const SLICE_MS = 8

/**
 * @param sliceMs How long to work before pausing.
 * @param now The clock, in milliseconds (replaceable in a test).
 * @param pause Lets everything else waiting run (replaceable in a test).
 * @returns A function to call after each unit of work; await it.
 */
export function timeSlicer(
  sliceMs: number = SLICE_MS,
  now: () => number = () => performance.now(),
  pause: () => Promise<void> = () => new Promise((resolve) => setImmediate(resolve))
): () => Promise<void> {
  let last = now()
  return async () => {
    if (now() - last < sliceMs) return
    await pause()
    last = now()
  }
}
