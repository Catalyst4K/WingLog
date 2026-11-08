/** A client's link to the sim PC's WingLog, as the screens show it. */

import { useEffect, useState } from 'react'
import type { HostLinkState, HostLinkStatus } from '@shared/ipc'
import type { LightState } from '@/components/StatusLight'
import { winglogApi } from '../data/winglog-api'
import { runAsync } from '../report-error'

/**
 * A client's link to the sim PC as a light: green connected, amber while it is connecting, not reachable or needs its code again, off
 * when no sim PC has been paired (nothing is wrong, so no alarm).
 *
 * @param state The link's state.
 * @returns The light's state.
 */
export function hostLinkLight(state: HostLinkState): LightState {
  if (state === 'connected') return 'green'
  return state === 'unpaired' ? 'off' : 'amber'
}

/**
 * Follows the link's status: read once, then pushed by the main process on every change.
 *
 * @param enabled Whether this run is a client; nothing is asked of the main process otherwise.
 * @returns The status, or null until it has been read (and always null when not enabled).
 */
export function useHostLinkStatus(enabled: boolean): HostLinkStatus | null {
  const [status, setStatus] = useState<HostLinkStatus | null>(null)
  useEffect(() => {
    if (!enabled) return
    let current = true
    runAsync(
      'useHostLinkStatus hostLinkGetStatus',
      winglogApi()
        .hostLinkGetStatus()
        .then((next) => {
          if (current) setStatus(next)
        })
    )
    const unsubscribe = winglogApi().onHostLinkStatus(setStatus)
    return () => {
      current = false
      unsubscribe()
    }
  }, [enabled])
  return status
}
