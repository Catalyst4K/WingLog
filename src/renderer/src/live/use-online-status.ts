/**
 * The pilot's online status (VATSIM or IVAO), followed live, for the screens that hide BeyondATC while the pilot is online. The PC window
 * and the phone read it the same way; main decides, once, whether BeyondATC is hidden (`hidesBeyondAtc`).
 */
import { useEffect, useState } from 'react'
import type { OnlineStatus } from '@shared/ipc'
import { reportError } from '../report-error'
import { useLiveClient } from './LiveClient'

/** The status before the first answer: nothing is hidden until main says so. */
const NOT_ONLINE: OnlineStatus = {
  network: null,
  state: 'unknown',
  callsign: null,
  filedPlan: null,
  hidesBeyondAtc: false
}

/**
 * @returns The latest online status. Stays "not online" if the live client cannot be reached, so BeyondATC is never hidden by a failure.
 */
export function useOnlineStatus(): OnlineStatus {
  const client = useLiveClient()
  const [status, setStatus] = useState<OnlineStatus>(NOT_ONLINE)
  useEffect(() => {
    let current = true
    try {
      client.get('onlineStatus').then(
        (held) => {
          if (current && held) setStatus(held)
        },
        (error: unknown) => reportError('online status', error)
      )
      const unsubscribe = client.subscribe('onlineStatus', setStatus)
      return () => {
        current = false
        unsubscribe()
      }
    } catch (error) {
      reportError('online status subscribe', error)
      return undefined
    }
  }, [client])
  return status
}

/**
 * @returns True while BeyondATC's prompts, taxi line and suggestions should be hidden because the pilot is online.
 */
export function useBeyondAtcHidden(): boolean {
  return useOnlineStatus().hidesBeyondAtc
}
