/**
 * What the page tells the PC about itself beyond a failure it gave up on (shared/lan-report.ts): that it has taken a taxi line, and when its
 * own script fails. The PC's log then shows both sides of a flaky moment: what it pushed and what the phone heard and did.
 */

import { useEffect, useRef } from 'react'
import type { LanConnection } from './lan-connection'
import { useTopic } from './use-link'

/** The least time between two reports of a taxi line: it is pushed every second of a taxi, and the PC writes one a minute anyway. */
const TAXI_REPORT_EVERY_MS = 30_000

/**
 * @param reason What an unhandled promise rejection was given.
 * @returns It as one line: an error's name and message (never its stack), or whatever else it was, as text.
 */
function reasonText(reason: unknown): string {
  return reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason)
}

/**
 * Reports each taxi line the PC pushes that the page has taken, at most once in a while.
 *
 * @param link The link to the PC.
 */
export function useReportTaxiRoute(link: LanConnection): void {
  const route = useTopic(link, 'taxiRoute')
  const lastReported = useRef(0)
  const revision = route && route.kind !== null ? route.revision : null
  useEffect(() => {
    if (revision === null || Date.now() - lastReported.current < TAXI_REPORT_EVERY_MS) return
    lastReported.current = Date.now()
    link.report('taxi-route-applied', `r${revision}`)
  }, [revision, link])
}

/**
 * Reports script that throws on the page, and promises rejected with nobody listening: the message only, never a stack. A phone has no
 * console to look at; this is how the PC's log learns that a page went wrong.
 *
 * @param link The link to the PC.
 */
export function useReportScriptErrors(link: LanConnection): void {
  useEffect(() => {
    const onError = (event: ErrorEvent): void => link.report('script-error', event.message)
    const onRejection = (event: PromiseRejectionEvent): void =>
      link.report('script-error', `Unhandled rejection: ${reasonText(event.reason)}`)
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [link])
}
