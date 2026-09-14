import { useEffect, useRef } from 'react'

/**
 * Runs `onReset` whenever `signal` changes — but never on the initial mount itself, only
 * on a later change while the component stays mounted (docs/plans/navigation-tab-
 * behaviour.md). App.tsx bumps a page's reset signal when its tab is clicked while already
 * active, the one case a plain prop change or remount can't reach: Radix's Tabs only fires
 * `onValueChange` on an actual value change, so re-clicking the active tab is otherwise a
 * no-op. Skipping the mount-time call matters because a view can be seeded with an initial
 * drill-down (e.g. LogbookView's `initialFlightId`, arriving from Fleet) — firing on mount
 * would immediately reset straight back out of it.
 */
export function useResetSignal(signal: number | undefined, onReset: () => void): void {
  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    onReset()
    // Deliberately re-runs only when `signal` changes — `onReset` is expected to be a
    // fresh closure each render (it usually just calls a setState), not a stable identity
    // worth tracking.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signal])
}
