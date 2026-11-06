/** Whether the window is narrow enough for the tab bar to fold its less-used tabs behind a menu. */

import { useEffect, useState } from 'react'

/** Below this width, in CSS pixels, the header shows Fleet, Dispatch, Track and Logbook and folds the rest behind "More". */
export const NARROW_WINDOW_PX = 800

/**
 * @returns True while the window is narrower than NARROW_WINDOW_PX. False where the window cannot say (a test environment).
 */
export function useNarrowWindow(): boolean {
  const query = `(max-width: ${NARROW_WINDOW_PX - 1}px)`
  const [narrow, setNarrow] = useState(() =>
    typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined
    const list = window.matchMedia(query)
    const update = (): void => setNarrow(list.matches)
    update()
    list.addEventListener('change', update)
    return () => list.removeEventListener('change', update)
  }, [query])
  return narrow
}
