/** The procedure choice a second screen shows and makes (winglog-backend's docs/plans/lan-sync.md, step 2). */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { LanFlightSnapshot, ProcedureSelection } from '@shared/ipc'
import { emptyProcedureSelection } from '@shared/procedure-selection'
import type { LanConnection } from './lan-connection'
import {
  choose as chooseSelection,
  CONFIRM_MS,
  confirmTimeout,
  initialChoice,
  NOTICE_MS,
  receiveRoute,
  reconnected,
  type ChoiceState
} from './selection-sync'
import { useTopic } from './use-link'

/**
 * The SID, STAR and approach shown for the flight, kept in step with the PC. What the PC has is what is shown: a change made in its
 * window or on another device arrives in the route it pushes. A choice made here is shown at once, sent, and sent again if the PC does
 * not confirm it; if it never does, the screen goes back to what the PC has and says so.
 *
 * @param link The link to the PC.
 * @param snapshot The flight shown, with the choice it has when the screen opens, or null.
 * @returns The choice shown, how to make a choice, and whether the last one could not be confirmed.
 */
export function useProcedureChoice(
  link: LanConnection,
  snapshot: LanFlightSnapshot | null
): { selection: ProcedureSelection; choose: (next: ProcedureSelection) => void; unconfirmed: boolean } {
  const flightId = snapshot?.flight.flightId
  const route = useTopic(link, 'plannedRoute')
  const shownRoute = route && route.flightId === flightId ? route : undefined
  const [state, setState] = useState<ChoiceState>(() =>
    initialChoice(snapshot?.flight.selection ?? emptyProcedureSelection())
  )
  // The state as the latest event left it, for the handlers below that must not act on a render's older copy.
  const stateRef = useRef(state)
  const routeRef = useRef(shownRoute)
  useEffect(() => {
    routeRef.current = shownRoute
  }, [shownRoute])
  const update = useCallback((next: ChoiceState) => {
    stateRef.current = next
    setState(next)
  }, [])

  const send = useCallback(
    (selection: ProcedureSelection) => {
      try {
        link.command('track.setProcedureSelection', selection)
      } catch {
        // Offline: the choice stays pending, and goes again when the link is back (below).
      }
    },
    [link]
  )

  // A route from the PC: a change made elsewhere, or the confirmation of ours.
  useEffect(() => {
    if (shownRoute) update(receiveRoute(stateRef.current, shownRoute))
  }, [shownRoute, update])

  // The link came back: the PC may have restarted, so its revisions start again, and a choice still waiting is sent now.
  useEffect(
    () =>
      link.onState((linkState) => {
        if (linkState !== 'connected') return
        const back = reconnected(stateRef.current)
        update(back.state)
        if (back.resend) send(back.resend)
      }),
    [link, send, update]
  )

  // A choice the PC has not confirmed is sent again after a few seconds, and given up on after the last send.
  const { pending } = state
  useEffect(() => {
    if (!pending) return
    const timer = setTimeout(() => {
      const next = confirmTimeout(stateRef.current, routeRef.current)
      update(next.state)
      if (next.resend) send(next.resend)
      if (next.state.unconfirmed) link.report('selection-unconfirmed')
    }, CONFIRM_MS)
    return () => clearTimeout(timer)
  }, [pending, link, send, update])

  const { unconfirmed } = state
  useEffect(() => {
    if (!unconfirmed) return
    const timer = setTimeout(() => update({ ...stateRef.current, unconfirmed: false }), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [unconfirmed, update])

  const choose = useCallback(
    (next: ProcedureSelection) => {
      const chosen = chooseSelection(stateRef.current, next)
      if (chosen === stateRef.current) return
      update(chosen)
      send(next)
    },
    [send, update]
  )

  return { selection: state.selection, choose, unconfirmed }
}
