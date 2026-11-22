/** A client's link to the sim PC's WingLog, as the screens show it. */

import { useEffect, useState } from 'react'
import type { HostLinkStatus } from '@shared/ipc'
import { winglogApi } from '../data/winglog-api'
import { runAsync } from '../report-error'

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
