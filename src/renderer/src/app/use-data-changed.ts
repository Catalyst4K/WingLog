/** Reading a list again when a sync with the sim PC has changed this computer's fleet or logbook. */

import { useEffect, useRef } from 'react'
import { winglogApi } from '../data/winglog-api'

/**
 * Calls a function each time a sync with the sim PC has brought in rows (a client only; a host never hears it).
 *
 * @param reload Reads the screen's list again. The latest one is called, so it may close over current state.
 */
export function useDataChanged(reload: () => void): void {
  const latest = useRef(reload)
  useEffect(() => {
    latest.current = reload
  })
  useEffect(() => {
    // The renderer's test doubles and a host have nothing to say: an api without the call just never fires.
    const api = winglogApi() as Partial<ReturnType<typeof winglogApi>>
    return api.onDataChanged?.(() => latest.current())
  }, [])
}
