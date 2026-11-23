/** The sim PC's device server status, read every two seconds while a screen shows it (the Devices page, its list entry, Add a device). */

import { useEffect, useRef, useState } from 'react'
import type { LanStatus } from '@shared/ipc'
import { winglogApi } from '../data/winglog-api'
import { runAsync } from '../report-error'

/** How often the status is read again, for the connected lights, the pairing countdown and the paired list. */
export const LAN_REFRESH_MS = 2000

/**
 * Follows the server's status: read now and every {@link LAN_REFRESH_MS}, and replaced by the status a change comes back with.
 *
 * @param enabled Whether to ask at all: a client runs no server, so it is never asked there.
 * @param onRead Called with each status read on the timer (not with one passed to `show`), and `show` itself, for a screen that reacts
 *   to it.
 * @returns The status (null until first read), and the function that shows the status a call came back with.
 */
export function useLanStatus(
  enabled: boolean,
  onRead?: (status: LanStatus, show: (status: LanStatus) => void) => void
): [LanStatus | null, (status: LanStatus) => void] {
  const [status, setStatus] = useState<LanStatus | null>(null)
  // Kept in a ref so a new function each render does not restart the timer.
  const readListener = useRef(onRead)
  useEffect(() => {
    readListener.current = onRead
  })
  useEffect(() => {
    if (!enabled) return
    const refresh = (): void =>
      runAsync(
        'useLanStatus lanGetStatus',
        winglogApi()
          .lanGetStatus()
          .then((next) => {
            // A client's answer is nothing.
            if (!next) return
            setStatus(next)
            readListener.current?.(next, setStatus)
          })
      )
    refresh()
    const timer = setInterval(refresh, LAN_REFRESH_MS)
    return () => clearInterval(timer)
  }, [enabled])
  return [status, setStatus]
}
